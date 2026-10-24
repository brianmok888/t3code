/**
 * Chunked JSONL reader for session files written by the omo native CLI.
 *
 * This module owns ONE concept: turning bytes on disk into validated header and
 * entry records plus the LINE-level defects found on the way. It knows nothing
 * about entry trees, adoption policy, or what a session means — that is
 * `omoCliSessionGraph.ts` and `omoCliSessionInspector.ts`.
 *
 * It NEVER imports senpi and never opens the file through its `SessionManager`.
 * That is not stylistic: `SessionManager` rewrites the file in place when it
 * migrates an older version (`core/session-manager.js:571-572` calls
 * `_rewriteFile()` right after `migrateToCurrentVersion`), so merely *looking*
 * at a user's session through the engine would rewrite the file the user's CLI
 * still owns. Adoption reads; it never touches the original.
 *
 * The file is read in bounded chunks and decoded incrementally, so a large
 * session never lands in memory whole.
 *
 * TOLERANCE RULE (the load-bearing rule here): a torn/unparseable FINAL line is
 * discarded and flagged, because an append-only writer killed mid-write leaves
 * exactly that and nothing committed is lost. A malformed line ANYWHERE ELSE is
 * kept as an interior defect — the tree it describes cannot be trusted.
 *
 * @module provider/omo/omoCliSessionReader
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { SessionNotFound } from "./omoCliSessionErrors.ts";

/** Read granularity. Chunks are bounded so a huge file never lands in memory. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

const SessionHeaderLine = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
  version: Schema.optional(Schema.Number),
  timestamp: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  parentSession: Schema.optional(Schema.String),
});
export type CliSessionHeader = typeof SessionHeaderLine.Type;

/**
 * The fields adoption reads off any entry. Kind-specific payloads stay
 * unvalidated on purpose: a session file may carry entries written by a newer
 * engine or an extension, and refusing to read those would make adoption
 * brittle against content it does not need to understand.
 */
const SessionEntryLine = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Struct({ role: Schema.optional(Schema.String) })),
  provider: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
export type CliSessionEntry = typeof SessionEntryLine.Type;

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeHeaderLine = Schema.decodeUnknownResult(SessionHeaderLine);
const decodeEntryLine = Schema.decodeUnknownResult(SessionEntryLine);

/** What one pass over the file found, before any tree analysis. */
export type CliSessionScan = {
  readonly header: CliSessionHeader | null;
  readonly entries: ReadonlyArray<CliSessionEntry>;
  /** 1-based physical line numbers that failed to parse, excluding a torn final line. */
  readonly malformedInteriorLines: ReadonlyArray<number>;
  readonly tornFinalLine: boolean;
};

/** Split accumulated text into complete lines, carrying the remainder forward. */
const drainLines = (pending: string): { readonly lines: Array<string>; readonly rest: string } => {
  const lines: Array<string> = [];
  let start = 0;
  let index = pending.indexOf("\n", start);
  while (index !== -1) {
    lines.push(pending.slice(start, index));
    start = index + 1;
    index = pending.indexOf("\n", start);
  }
  return { lines, rest: pending.slice(start) };
};

/** Mutable accumulator for one pass over the file. */
type ScanState = {
  header: CliSessionHeader | null;
  readonly entries: Array<CliSessionEntry>;
  readonly malformedInteriorLines: Array<number>;
  lineNumber: number;
  lastMalformedLine: number | null;
};

const consumeLine = (state: ScanState, line: string): void => {
  state.lineNumber += 1;
  if (line.trim().length === 0) return;

  const json = decodeJson(line);
  if (Result.isFailure(json)) {
    state.malformedInteriorLines.push(state.lineNumber);
    state.lastMalformedLine = state.lineNumber;
    return;
  }

  // Only the first meaningful line may be the header, matching the engine's own
  // header validation (`core/session-manager.js:352`).
  const isFirstMeaningfulLine =
    state.header === null &&
    state.entries.length === 0 &&
    state.malformedInteriorLines.length === 0;
  if (isFirstMeaningfulLine) {
    const asHeader = decodeHeaderLine(json.success);
    if (Result.isSuccess(asHeader)) {
      state.header = asHeader.success;
      return;
    }
  }

  const entry = decodeEntryLine(json.success);
  if (Result.isFailure(entry)) {
    state.malformedInteriorLines.push(state.lineNumber);
    state.lastMalformedLine = state.lineNumber;
    return;
  }
  // Validation proves the shape; the ORIGINAL object is what gets kept.
  // Decoding a struct drops unknown keys — including nested ones — and those
  // keys ARE the content (message bodies, compaction summaries, model ids).
  // Adoption presents itself as a faithful copy, so the read path must not
  // silently lose them. Only the trimmed/normalized top-level identity fields
  // are taken from the decoded value.
  state.entries.push({
    ...(json.success as Record<string, unknown>),
    type: entry.success.type,
    id: entry.success.id,
    parentId: entry.success.parentId,
  } as CliSessionEntry);
};

/**
 * Read one session file in bounded chunks.
 *
 * Fails only when the file cannot be read at all; every content problem is
 * reported in the returned scan so callers can explain WHY a session is
 * unusable rather than only that it is.
 */
export const scanCliSessionFile = (
  sessionPath: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Effect.Effect<CliSessionScan, SessionNotFound, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const decoder = new TextDecoder("utf-8");
    const state: ScanState = {
      header: null,
      entries: [],
      malformedInteriorLines: [],
      lineNumber: 0,
      lastMalformedLine: null,
    };

    let pending = "";
    yield* fs.stream(sessionPath, { chunkSize }).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          pending += decoder.decode(chunk, { stream: true });
          const drained = drainLines(pending);
          for (const line of drained.lines) consumeLine(state, line);
          pending = drained.rest;
        }),
      ),
      Effect.mapError(() => new SessionNotFound({ sessionPath })),
    );

    // Text left over after the last newline is a final line with no terminator:
    // exactly what a writer killed mid-append leaves behind.
    pending += decoder.decode();
    const endsWithoutNewline = pending.length > 0;
    if (endsWithoutNewline) consumeLine(state, pending);

    // TOLERANCE RULE: only the LAST physical line may be torn. A malformed line
    // earlier in the file stays an interior defect.
    const tornFinalLine =
      endsWithoutNewline &&
      state.lastMalformedLine !== null &&
      state.lastMalformedLine === state.lineNumber;

    return {
      header: state.header,
      entries: state.entries,
      malformedInteriorLines: tornFinalLine
        ? state.malformedInteriorLines.filter((line) => line !== state.lastMalformedLine)
        : state.malformedInteriorLines,
      tornFinalLine,
    };
  });
