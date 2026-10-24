import type { ThreadActiveMonitor } from "@t3tools/contracts";

export const OMO_MONITOR_NOTIFICATION_CUSTOM_TYPE = "omo-monitor:notification";

/** The omo tool whose lifecycle creates a background monitor. */
export const isOmoMonitorToolName = (toolName: string | undefined): boolean =>
  toolName === "monitor";

type RecordLike = Readonly<Record<string, unknown>>;
type Warn = (message: string) => void;

export type OmoMonitorToolResult = {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
  readonly occurredAtMs: number;
};

export type OmoMonitorProjection = {
  readonly snapshot: () => readonly ThreadActiveMonitor[];
  readonly apply: (input: OmoMonitorToolResult) => boolean;
  readonly applyStateEvent: (monitors: readonly ThreadActiveMonitor[]) => boolean;
};

const isRecord = (value: unknown): value is RecordLike =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const recordString = (value: unknown, key: string): string | undefined =>
  isRecord(value) ? nonEmptyString(value[key]) : undefined;

const resultText = (result: unknown): string | undefined => {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return undefined;
  const direct = nonEmptyString(result.text);
  if (direct !== undefined) return direct;
  if (!Array.isArray(result.content)) return undefined;
  const text = result.content
    .map((part) =>
      isRecord(part) && part.type === "text" ? (nonEmptyString(part.text) ?? "") : "",
    )
    .join("");
  return nonEmptyString(text);
};

const monitorBashId = (result: unknown): string | undefined => {
  if (isRecord(result)) {
    const direct = recordString(result, "bash_id") ?? recordString(result, "bashId");
    if (direct !== undefined) return direct;
    if (isRecord(result.details)) {
      const details =
        recordString(result.details, "bash_id") ?? recordString(result.details, "bashId");
      if (details !== undefined) return details;
    }
  }
  const text = resultText(result);
  if (text === undefined) return undefined;
  return nonEmptyString(/Monitor started with ID:\s*([^\s.]+)/i.exec(text)?.[1]);
};

const validOccurredAtMs = (value: number): number =>
  Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

export const createOmoMonitorProjection = (warn: Warn = () => undefined): OmoMonitorProjection => {
  const monitors = new Map<string, ThreadActiveMonitor>();

  const snapshot = (): readonly ThreadActiveMonitor[] =>
    [...monitors.values()].map((monitor) => ({ ...monitor }));

  const apply = (input: OmoMonitorToolResult): boolean => {
    if (input.isError) return false;
    const toolName = input.toolName.trim().toLowerCase();
    const args = isRecord(input.args) ? input.args : {};

    if (isOmoMonitorToolName(toolName)) {
      const action = recordString(args, "action") ?? "create";
      if (action === "rearm") {
        const bashId = recordString(args, "bash_id") ?? recordString(args, "bashId");
        if (bashId === undefined) return false;
        const monitor = monitors.get(bashId);
        if (monitor === undefined || monitor.status === "active") return false;
        monitors.set(bashId, { ...monitor, status: "active" });
        return true;
      }
      if (action !== "create") return false;

      const description = recordString(args, "description");
      if (description === undefined) {
        warn("omo monitor create result omitted a non-empty description; monitor was skipped");
        return false;
      }
      const bashId = monitorBashId(input.result);
      if (bashId === undefined) {
        warn("omo monitor create result omitted bash_id; monitor was skipped");
        return false;
      }
      const next: ThreadActiveMonitor = {
        bashId,
        description,
        startedAtMs: validOccurredAtMs(input.occurredAtMs),
        status: "active",
      };
      const previous = monitors.get(bashId);
      monitors.set(bashId, next);
      return (
        previous === undefined ||
        previous.description !== next.description ||
        previous.startedAtMs !== next.startedAtMs ||
        previous.status !== next.status
      );
    }

    if (toolName !== "kill_bash") return false;
    if (args.all === true) {
      let changed = false;
      for (const [bashId, monitor] of monitors) {
        if (monitor.status === "ended") continue;
        monitors.set(bashId, { ...monitor, status: "ended" });
        changed = true;
      }
      return changed;
    }
    const bashId = recordString(args, "bash_id") ?? recordString(args, "bashId");
    if (bashId === undefined) return false;
    const monitor = monitors.get(bashId);
    if (monitor === undefined || monitor.status === "ended") return false;
    monitors.set(bashId, { ...monitor, status: "ended" });
    return true;
  };

  const applyStateEvent = (next: readonly ThreadActiveMonitor[]): boolean => {
    let changed = false;
    const live = new Set<string>();
    for (const reported of next) {
      live.add(reported.bashId);
      const previous = monitors.get(reported.bashId);
      if (previous?.status === reported.status) continue;
      monitors.set(reported.bashId, {
        ...reported,
        startedAtMs: previous?.startedAtMs ?? reported.startedAtMs,
      });
      changed = true;
    }
    for (const [bashId, monitor] of monitors) {
      if (live.has(bashId) || monitor.status === "ended") continue;
      monitors.set(bashId, { ...monitor, status: "ended" });
      changed = true;
    }
    return changed;
  };

  return { snapshot, apply, applyStateEvent };
};

export const projectOmoMonitorToolResult = (
  projection: OmoMonitorProjection,
  input: OmoMonitorToolResult,
): boolean => projection.apply(input);

/**
 * Applies omo's authoritative monitor snapshot. A monitor the snapshot omits is
 * ended, which is the ONLY way a natural exit (command finished on its own,
 * never killed) becomes observable here.
 */
export const applyOmoMonitorStateEvent = (
  projection: OmoMonitorProjection,
  monitors: readonly ThreadActiveMonitor[],
): boolean => projection.applyStateEvent(monitors);

type HydrationToolCall = {
  readonly toolName: string;
  readonly args: unknown;
};

const entryTimestampMs = (entry: RecordLike): number => {
  const timestamp = entry.timestamp;
  if (typeof timestamp === "number") return validOccurredAtMs(timestamp);
  if (typeof timestamp !== "string") return 0;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const entryChain = (entries: readonly unknown[], leafId: string | null): readonly RecordLike[] => {
  const records = entries.filter(isRecord);
  if (leafId === null) return records;
  const byId = new Map<string, RecordLike>();
  for (const entry of records) {
    const id = recordString(entry, "id");
    if (id !== undefined) byId.set(id, entry);
  }
  const chain: RecordLike[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) break;
    chain.push(entry);
    cursor = entry.parentId === null ? null : (recordString(entry, "parentId") ?? null);
  }
  return chain.toReversed();
};

const toolCallsFromMessage = (message: RecordLike): readonly [string, HydrationToolCall][] => {
  if (!Array.isArray(message.content)) return [];
  const calls: Array<[string, HydrationToolCall]> = [];
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "toolCall") continue;
    const id = recordString(part, "id") ?? recordString(part, "toolCallId");
    const toolName = recordString(part, "name") ?? recordString(part, "toolName");
    if (id === undefined || toolName === undefined) continue;
    calls.push([
      id,
      {
        toolName,
        args: part.arguments ?? part.input,
      },
    ]);
  }
  return calls;
};

/**
 * Replays only the selected get_entries ancestry. The in-process
 * `terminal_monitor_state` event is intentionally not a source: it never crosses
 * omo RPC. Wake-budget pauses are likewise unobservable, so replay preserves
 * the last toolcall-derived active/ended status and never invents "paused".
 */
export const hydrateOmoMonitorProjection = (
  entries: readonly unknown[],
  leafId: string | null,
  warn?: Warn,
): OmoMonitorProjection => {
  const projection = createOmoMonitorProjection(warn);
  const calls = new Map<string, HydrationToolCall>();

  for (const entry of entryChain(entries, leafId)) {
    if (entry.type === "toolcall_end") {
      projectOmoMonitorToolResult(projection, {
        toolName: recordString(entry, "toolName") ?? recordString(entry, "name") ?? "",
        args: entry.args ?? entry.arguments,
        result: entry.result,
        isError: entry.isError === true,
        occurredAtMs: entryTimestampMs(entry),
      });
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const [id, call] of toolCallsFromMessage(message)) calls.set(id, call);
      continue;
    }
    if (message.role !== "toolResult" && message.role !== "tool") continue;
    const toolCallId = recordString(message, "toolCallId") ?? recordString(message, "tool_call_id");
    const call = toolCallId === undefined ? undefined : calls.get(toolCallId);
    const toolName = recordString(message, "toolName") ?? call?.toolName;
    if (toolName === undefined) continue;
    projectOmoMonitorToolResult(projection, {
      toolName,
      args: message.input ?? call?.args,
      result: message,
      isError: message.isError === true,
      occurredAtMs: entryTimestampMs(entry),
    });
  }

  return projection;
};

export const isOmoMonitorNotification = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.customType === OMO_MONITOR_NOTIFICATION_CUSTOM_TYPE) return true;
  return (
    isRecord(value.message) && value.message.customType === OMO_MONITOR_NOTIFICATION_CUSTOM_TYPE
  );
};

export const markOmoMonitorEvent = (value: unknown): unknown => {
  if (!isOmoMonitorNotification(value) || !isRecord(value)) return value;
  if (
    isRecord(value.message) &&
    value.message.customType === OMO_MONITOR_NOTIFICATION_CUSTOM_TYPE
  ) {
    return { ...value, message: { ...value.message, monitorEvent: true }, monitorEvent: true };
  }
  return { ...value, monitorEvent: true };
};
