/**
 * Turns a projected CLI session into bounded, replayable history batches.
 *
 * The projection itself lives in `omoCliSessionProjection.ts` and is reused
 * verbatim; this module owns only what ingress needs on top of it: a
 * DETERMINISTIC message id per (threadId, entryId), a bound on how many
 * entries one command may carry, and the thread title rule.
 *
 * Determinism is the crash-safety property. A dispatch interrupted halfway
 * through is retried from the start, and because every id is a pure function
 * of the thread and the source entry, the replayed rows upsert onto themselves
 * instead of appending a second copy of the conversation.
 *
 * @module provider/omo/omoCliSessionHistoryBatches
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { MessageId, type ThreadId, type ThreadMessageHistoryEntry } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { CliSessionEntry } from "./omoCliSessionReader.ts";
import { projectCliSession } from "./omoCliSessionProjection.ts";

/** Upper bound on entries per `thread.message.history.append` dispatch. */
export const HISTORY_APPEND_MAX_BATCH = 200;

/** Longest thread title derived from a first user message. */
export const HISTORY_TITLE_MAX_CHARS = 80;

/** Title used when a session has neither a name nor a user message. */
export const HISTORY_FALLBACK_TITLE = "Adopted CLI session";

/**
 * Timestamp for an entry the projection could not date.
 *
 * Same epoch-zero instant the projection itself falls back to, rendered
 * through `DateTime` rather than a global `Date` so the value never depends on
 * a clock — the ISO string is identical to `new Date(0).toISOString()`, and
 * this one is persisted on the history row.
 */
const EPOCH_ISO = DateTime.formatIso(DateTime.makeUnsafe(0));

export type BuildHistoryEntriesInput = {
  readonly threadId: ThreadId;
  readonly entries: ReadonlyArray<CliSessionEntry>;
  readonly currentLeafPath: ReadonlyArray<string>;
};

/**
 * Message id for one source entry.
 *
 * A hash keeps the id length bounded regardless of the source ids, and mixing
 * the thread id in means the same CLI session adopted into two threads never
 * collides on a message row.
 */
export const historyMessageId = (threadId: ThreadId, entryId: string): MessageId => {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${threadId}\u0000${entryId}`)
    .digest("hex")
    .slice(0, 32);
  return MessageId.make(`cli-${digest}`);
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Project the session's current leaf path into ingress entries.
 *
 * Only user and assistant messages become history entries; everything else the
 * projection produces is an activity, and activities are not messages.
 */
export const buildHistoryEntries = (
  input: BuildHistoryEntriesInput,
): ReadonlyArray<ThreadMessageHistoryEntry> => {
  const projection = projectCliSession({
    threadId: input.threadId,
    entries: input.entries,
    currentLeafPath: input.currentLeafPath,
  });
  const entries: Array<ThreadMessageHistoryEntry> = [];
  for (const message of projection.messages) {
    const entryId = asString(message.messageId);
    const role = asString(message.role);
    if (entryId === null || (role !== "user" && role !== "assistant")) continue;
    const timestamp = asString(message.createdAt) ?? EPOCH_ISO;
    entries.push({
      entryId,
      messageId: historyMessageId(input.threadId, entryId),
      role,
      text: asString(message.text) ?? "",
      timestamp,
    });
  }
  return entries;
};

/** Split entries into dispatch-sized batches, preserving source order. */
export const splitHistoryBatches = (
  entries: ReadonlyArray<ThreadMessageHistoryEntry>,
  batchSize: number = HISTORY_APPEND_MAX_BATCH,
): ReadonlyArray<ReadonlyArray<ThreadMessageHistoryEntry>> => {
  const bounded = Math.max(1, Math.min(batchSize, HISTORY_APPEND_MAX_BATCH));
  const batches: Array<ReadonlyArray<ThreadMessageHistoryEntry>> = [];
  for (let index = 0; index < entries.length; index += bounded) {
    batches.push(entries.slice(index, index + bounded));
  }
  return batches;
};

/**
 * Thread title: the session's own name if it has one, else the first user
 * message truncated to 80 characters.
 */
export const threadTitleFromHistory = (input: {
  readonly sessionName: string | null;
  readonly entries: ReadonlyArray<ThreadMessageHistoryEntry>;
}): string => {
  const name = input.sessionName?.trim();
  if (name !== undefined && name.length > 0) return name;
  const firstUserText = input.entries.find((entry) => entry.role === "user")?.text.trim() ?? "";
  const truncated = firstUserText.slice(0, HISTORY_TITLE_MAX_CHARS).trim();
  return truncated.length > 0 ? truncated : HISTORY_FALLBACK_TITLE;
};

/**
 * Title for a thread adopted from these entries: the name the session carries
 * (the last `session_info`/`label` wins), else its first user message.
 */
export const threadTitleForAdoptedSession = (
  input: BuildHistoryEntriesInput & { readonly fallbackSessionName: string | null },
): string => {
  const projection = projectCliSession({
    threadId: input.threadId,
    entries: input.entries,
    currentLeafPath: input.currentLeafPath,
  });
  return threadTitleFromHistory({
    sessionName: asString(asRecord(projection.metadata).name) ?? input.fallbackSessionName,
    entries: buildHistoryEntries(input),
  });
};
