/**
 * Read-only inspection of a session file written by the omo native CLI.
 *
 * This module composes the two halves of the read path — `omoCliSessionReader.ts`
 * (bytes to validated entries plus line-level defects) and
 * `omoCliSessionGraph.ts` (the `id`/`parentId` tree, including the head rule) —
 * and adds what only a whole-file view can decide: the byte ceiling, the
 * content projection (message counts, session name, timestamps), and whether
 * the session may be adopted at all.
 *
 * Nothing here writes, and nothing in this read path imports senpi: its
 * `SessionManager` rewrites a file in place while migrating it
 * (`core/session-manager.js:571-572`), which would corrupt the original the
 * user's CLI still owns.
 *
 * ADOPTABILITY POLICY: any defect except a torn final line blocks adoption, and
 * so does a version above `CURRENT_SESSION_VERSION`. A torn final line is
 * tolerated because an append-only writer killed mid-write leaves exactly that.
 *
 * Unlike the engine, which silently drops entry kinds it does not know
 * (`core/session-manager.js:234-268`), unknown kinds are REPORTED here: they are
 * content, and adoption must not quietly lose content it then presents as a
 * faithful copy.
 *
 * @module provider/omo/omoCliSessionInspector
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { SessionNotFound, SessionTooLarge } from "./omoCliSessionErrors.ts";
import { analyzeCliSessionGraph } from "./omoCliSessionGraph.ts";
import {
  DEFAULT_CHUNK_SIZE,
  scanCliSessionFile,
  type CliSessionEntry,
  type CliSessionScan,
} from "./omoCliSessionReader.ts";

/** Highest session version this build understands (`CURRENT_SESSION_VERSION = 3`). */
export const SUPPORTED_SESSION_VERSION = 3;

/** Refusal ceiling; a session past this is a pathology, not a conversation. */
export const MAX_SESSION_BYTE_SIZE = 100 * 1024 * 1024;

/** Entry kinds senpi persists; anything else is reported as an unknown kind. */
const KNOWN_ENTRY_TYPES = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "custom",
  "custom_message",
  "compaction",
  "branch_summary",
  "label",
  "session_info",
]);

export type CliSessionMessageCounts = {
  readonly user: number;
  readonly assistant: number;
  readonly toolResult: number;
};

export type CliSessionDefects = {
  readonly duplicateEntryIds: ReadonlyArray<string>;
  readonly unknownParentIds: ReadonlyArray<string>;
  readonly cycles: ReadonlyArray<string>;
  readonly malformedInteriorLines: ReadonlyArray<number>;
  readonly tornFinalLine: boolean;
  readonly unsupportedVersion: boolean;
  readonly missingHeader: boolean;
};

export type CliSessionInspection = {
  readonly sessionPath: string;
  readonly sessionId: string | null;
  readonly version: number | null;
  readonly cwd: string | null;
  readonly parentSessionId: string | null;
  readonly headerTimestamp: string | null;
  readonly entryCount: number;
  readonly messageCounts: CliSessionMessageCounts;
  readonly sessionName: string | null;
  readonly lastProvider: string | null;
  readonly lastModel: string | null;
  readonly lastTimestamp: string | null;
  readonly currentLeafPath: ReadonlyArray<string>;
  readonly multiLeaf: boolean;
  readonly unknownEntryKinds: ReadonlyArray<string>;
  readonly defects: CliSessionDefects;
  readonly adoptable: boolean;
};

export type InspectCliSessionOptions = {
  readonly maxByteSize?: number;
  readonly chunkSize?: number;
};

type CliSessionContent = {
  readonly messageCounts: CliSessionMessageCounts;
  readonly sessionName: string | null;
  readonly lastTimestamp: string | null;
  readonly unknownEntryKinds: ReadonlyArray<string>;
};

/** Project the entries into what a user sees: role counts, name, recency, unknown kinds. */
const readContent = (
  entries: ReadonlyArray<CliSessionEntry>,
  headerTimestamp: string | null,
): CliSessionContent => {
  const unknownEntryKinds: Array<string> = [];
  let user = 0;
  let assistant = 0;
  let toolResult = 0;
  let sessionName: string | null = null;
  let lastTimestamp = headerTimestamp;

  for (const entry of entries) {
    if (!KNOWN_ENTRY_TYPES.has(entry.type) && !unknownEntryKinds.includes(entry.type)) {
      unknownEntryKinds.push(entry.type);
    }
    if (entry.type === "message") {
      const role = entry.message?.role;
      if (role === "user") user += 1;
      else if (role === "assistant") assistant += 1;
      else if (role === "toolResult") toolResult += 1;
    }
    // The LAST session_info wins: renaming a session appends a new entry.
    if (entry.type === "session_info") sessionName = entry.name ?? null;
    if (entry.timestamp !== undefined) lastTimestamp = entry.timestamp;
  }

  return {
    messageCounts: { user, assistant, toolResult },
    sessionName,
    lastTimestamp,
    unknownEntryKinds,
  };
};

const summarize = (sessionPath: string, scan: CliSessionScan): CliSessionInspection => {
  const { entries, header } = scan;
  const graph = analyzeCliSessionGraph(entries);
  const content = readContent(entries, header?.timestamp ?? null);
  const version = header?.version ?? null;

  const defects: CliSessionDefects = {
    duplicateEntryIds: graph.defects.duplicateEntryIds,
    unknownParentIds: graph.defects.unknownParentIds,
    cycles: graph.defects.cycles,
    malformedInteriorLines: scan.malformedInteriorLines,
    tornFinalLine: scan.tornFinalLine,
    unsupportedVersion: version !== null && version > SUPPORTED_SESSION_VERSION,
    missingHeader: header === null,
  };

  const adoptable =
    defects.duplicateEntryIds.length === 0 &&
    defects.unknownParentIds.length === 0 &&
    defects.cycles.length === 0 &&
    defects.malformedInteriorLines.length === 0 &&
    !defects.unsupportedVersion &&
    !defects.missingHeader;

  return {
    sessionPath,
    sessionId: header?.id ?? null,
    version,
    cwd: header?.cwd ?? null,
    parentSessionId: header?.parentSession ?? null,
    headerTimestamp: header?.timestamp ?? null,
    entryCount: entries.length,
    messageCounts: content.messageCounts,
    sessionName: content.sessionName,
    lastProvider: graph.lastProvider,
    lastModel: graph.lastModel,
    lastTimestamp: content.lastTimestamp,
    currentLeafPath: graph.currentLeafPath,
    multiLeaf: graph.multiLeaf,
    unknownEntryKinds: content.unknownEntryKinds,
    defects,
    adoptable,
  };
};

/**
 * Inspect one CLI session file without modifying it.
 *
 * Fails only for conditions that make inspection impossible: an absent or
 * unreadable path (`SessionNotFound`) and a file past the byte ceiling
 * (`SessionTooLarge`). Everything else — corruption, unsupported versions,
 * ambiguous trees — is reported inside the returned value so a caller can show
 * the user WHY a session cannot be adopted instead of only that it cannot.
 */
export const inspectCliSessionFile = (
  sessionPath: string,
  options: InspectCliSessionOptions = {},
): Effect.Effect<CliSessionInspection, SessionNotFound | SessionTooLarge, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const maxByteSize = options.maxByteSize ?? MAX_SESSION_BYTE_SIZE;

    const info = yield* fs
      .stat(sessionPath)
      .pipe(Effect.mapError(() => new SessionNotFound({ sessionPath })));
    if (info.type !== "File") return yield* new SessionNotFound({ sessionPath });

    const byteSize = Number(info.size);
    if (byteSize > maxByteSize) {
      return yield* new SessionTooLarge({ sessionPath, byteSize, maxByteSize });
    }

    const scan = yield* scanCliSessionFile(sessionPath, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    return summarize(sessionPath, scan);
  });
