import * as DateTime from "effect/DateTime";

import type { CliSessionEntry } from "./omoCliSessionReader.ts";

type OpaqueEntry = CliSessionEntry & Record<string, unknown>;

/**
 * Timestamp for an entry whose source file carries none.
 *
 * Epoch zero sorts an undated entry before every dated one, which is what the
 * ordering wants: an entry the CLI never stamped is older than anything it
 * did. Rendered through `DateTime` rather than a global `Date` so the value is
 * clock-independent — the ISO string is identical to `new Date(0).toISOString()`.
 */
const EPOCH_ISO = DateTime.formatIso(DateTime.makeUnsafe(0));

export type CliSessionProjectionInput = {
  readonly threadId: string;
  readonly entries: ReadonlyArray<CliSessionEntry>;
  readonly currentLeafPath: ReadonlyArray<string>;
};

export type CliSessionProjection = {
  readonly messages: ReadonlyArray<Record<string, unknown>>;
  readonly activities: ReadonlyArray<Record<string, unknown>>;
  readonly metadata: Record<string, string>;
  readonly unknownEntryKinds: Readonly<Record<string, number>>;
  readonly entryIds: ReadonlyArray<string>;
  readonly turns: ReadonlyArray<never>;
  readonly checkpoints: ReadonlyArray<never>;
};

const asOpaque = (entry: CliSessionEntry): OpaqueEntry => entry as OpaqueEntry;
const payload = (entry: OpaqueEntry): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!["type", "id", "parentId", "timestamp"].includes(key)) result[key] = value;
  }
  return result;
};
const textOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (part && typeof part === "object" && "text" in part ? part.text : ""))
    .filter((part): part is string => typeof part === "string")
    .join("");
};
const activity = (
  input: CliSessionProjectionInput,
  entry: OpaqueEntry,
  kind: string,
  tone: "info" | "tool" | "approval" | "error",
  value: unknown,
  sequence: number,
): Record<string, unknown> => ({
  activityId: entry.id,
  threadId: input.threadId,
  turnId: null,
  tone,
  kind,
  summary: kind.replaceAll("_", " "),
  payload: value,
  sequence,
  createdAt: entry.timestamp ?? EPOCH_ISO,
});

const projectEntry = (
  input: CliSessionProjectionInput,
  entry: OpaqueEntry,
  sequence: number,
  messages: Array<Record<string, unknown>>,
  activities: Array<Record<string, unknown>>,
  metadata: Record<string, string>,
  unknown: Record<string, number>,
): void => {
  const message = entry.message as Record<string, unknown> | undefined;
  const role = message?.role;
  if (entry.type === "message" && (role === "user" || role === "assistant")) {
    const timestamp = entry.timestamp ?? EPOCH_ISO;
    messages.push({
      messageId: entry.id,
      threadId: input.threadId,
      turnId: null,
      role,
      text: textOf(message?.content),
      isStreaming: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (role === "assistant") {
      const assistantMeta = Object.fromEntries(
        ["usage", "model", "provider", "stopReason"].flatMap((key) =>
          message?.[key] === undefined ? [] : [[key, message[key]]],
        ),
      );
      if (Object.keys(assistantMeta).length > 0) {
        activities.push(
          activity(
            input,
            { ...entry, id: `${entry.id}:metadata` },
            "message_metadata",
            "info",
            assistantMeta,
            sequence,
          ),
        );
      }
    }
    return;
  }
  if (entry.type === "message" && role === "toolResult") {
    activities.push(activity(input, entry, "tool_result", "tool", message, sequence));
    return;
  }
  if (entry.type === "model_change" || entry.type === "thinking_level_change") {
    activities.push(activity(input, entry, entry.type, "info", payload(entry), sequence));
    return;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    activities.push(activity(input, entry, entry.type, "info", payload(entry), sequence));
    return;
  }
  if (entry.type === "label" || entry.type === "session_info") {
    const name = entry.name;
    if (typeof name === "string") metadata.name = name;
    return;
  }
  if (entry.type === "custom" || entry.type === "custom_message") {
    activities.push(activity(input, entry, "custom", "info", payload(entry), sequence));
    return;
  }
  unknown[entry.type] = (unknown[entry.type] ?? 0) + 1;
  activities.push(activity(input, entry, "unknown", "info", { ...entry }, sequence));
};

export const projectCliSession = (input: CliSessionProjectionInput): CliSessionProjection => {
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const messages: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];
  const metadata: Record<string, string> = {};
  const unknown: Record<string, number> = {};
  input.currentLeafPath.forEach((id, sequence) => {
    const entry = byId.get(id);
    if (entry !== undefined)
      projectEntry(input, asOpaque(entry), sequence, messages, activities, metadata, unknown);
  });
  return {
    messages,
    activities,
    metadata,
    unknownEntryKinds: unknown,
    entryIds: [...input.currentLeafPath],
    turns: [],
    checkpoints: [],
  };
};
