import type { ThreadActiveMonitor } from "@t3tools/contracts";

/**
 * omo's `TERMINAL_MONITOR_STATE_EVENT` (senpi `monitor-state-event.ts`), which
 * reaches us inside the generic `extension_event` envelope as
 * `{ name: "terminal_monitor_state", data }`.
 */
export const OMO_MONITOR_STATE_EVENT_NAME = "terminal_monitor_state";

type RecordLike = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is RecordLike =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result.length === 0 ? undefined : result;
};

const startedAt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

/**
 * Decodes the authoritative snapshot into contract records.
 *
 * `undefined` means "this payload carries no per-monitor detail" and MUST be
 * treated as absence, never as an empty snapshot: an older omo build sends the
 * count alone, and reading that as "no monitors are live" would silently end
 * every watch. An explicit empty `monitors` array IS authoritative emptiness.
 */
export const decodeOmoMonitorStateEvent = (
  data: unknown,
): readonly ThreadActiveMonitor[] | undefined => {
  if (!isRecord(data)) return undefined;
  if (typeof data.activeCount !== "number") return undefined;
  if (!Array.isArray(data.monitors)) return undefined;
  const monitors: ThreadActiveMonitor[] = [];
  for (const entry of data.monitors) {
    if (!isRecord(entry)) continue;
    const bashId = trimmed(entry.id);
    const description = trimmed(entry.description);
    if (bashId === undefined || description === undefined) continue;
    monitors.push({
      bashId,
      description,
      startedAtMs: startedAt(entry.startedAtMs),
      status: entry.paused === true ? "paused" : "active",
    });
  }
  return monitors;
};
