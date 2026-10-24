/**
 * Filesystem mechanics for the CLI session catalog: enumerate, stat, sort, peek, hash.
 *
 * Owns NO policy. Which file belongs to a workspace, what suppresses a row and
 * how duplicates resolve all live in `omoCliSessionCatalog.ts`. This module
 * only turns a sessions root into an mtime-ordered list of candidate files, and
 * provides the two bounded reads the policy needs.
 *
 * PRIVACY: `peekCliSessionHeader` reads a bounded prefix and decodes ONLY the
 * first line. A non-matching session's entries — its names, its titles — are
 * never decoded into memory, because the candidate store holds thousands of
 * other projects' directories.
 *
 * @module provider/omo/omoCliSessionCatalogScan
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const SESSION_FILE_SUFFIX = ".jsonl";
const ARTIFACTS_DIR_SUFFIX = "-artifacts";
/** Header lines are small; this bounds the raw-byte read, never the decode. */
const HEADER_READ_BYTES = 8192;

/** Sort key for one session file, and the cursor shape pagination reuses. */
export type CliSessionFileKey = {
  readonly modifiedAtMs: number;
  readonly sessionPath: string;
};

export type ScannedCliSessionFile = CliSessionFileKey;

const PeekedHeaderLine = Schema.Struct({
  id: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodePeekedHeader = Schema.decodeUnknownResult(PeekedHeaderLine);

export type PeekedCliSessionHeader = {
  readonly id: string | null;
  readonly cwd: string | null;
};

/**
 * Read only the header line of a session file. Never fails: an unreadable,
 * empty or unparseable file yields nulls, which the caller treats as
 * "cannot be attributed to any workspace" and skips without inspecting.
 */
export const peekCliSessionHeader = (
  sessionPath: string,
): Effect.Effect<PeekedCliSessionHeader, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* Effect.gen(function* () {
      const file = yield* fs.open(sessionPath);
      return yield* file.readAlloc(HEADER_READ_BYTES);
    }).pipe(Effect.scoped, Effect.option, Effect.map(Option.flatten));
    if (Option.isNone(bytes)) return { id: null, cwd: null };

    const raw = bytes.value;
    const newline = raw.indexOf(0x0a);
    const line = new TextDecoder().decode(newline === -1 ? raw : raw.subarray(0, newline));
    const json = decodeJson(line);
    if (Result.isFailure(json)) return { id: null, cwd: null };
    const header = decodePeekedHeader(json.success);
    if (Result.isFailure(header)) return { id: null, cwd: null };
    return { id: header.success.id ?? null, cwd: header.success.cwd ?? null };
  });

/**
 * Content hash of a session file, used only to compare same-id duplicates.
 * Returns `None` when the file cannot be read: a failed read must never
 * fabricate an identity (two empty digests compare equal), so callers treat
 * `None` as "identity unprovable".
 */
export const hashCliSessionFileSha256 = (
  sessionPath: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = NodeCrypto.createHash("sha256");
    const streamed = yield* fs.stream(sessionPath).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    return streamed ? Option.some(hash.digest("hex")) : Option.none();
  });

export type CliSessionCandidateScan =
  | { readonly rootMissing: true }
  | { readonly rootMissing: false; readonly files: ReadonlyArray<ScannedCliSessionFile> };

/**
 * Enumerate candidate session files for one workspace, cheapest work first:
 * one directory listing of the root, one listing per CANDIDATE directory only,
 * then a stat per `*.jsonl`. Never recurses outside the candidate directories.
 *
 * Output is sorted by mtime descending (path ascending as the tie-break) so the
 * caller can inspect lazily in recency order, and pre-filtered to files strictly
 * after `after` when paginating.
 */
export const scanCliSessionCandidates = (input: {
  readonly sessionsRoot: string;
  readonly matchesCandidateDir: (directoryName: string) => boolean;
  readonly after?: CliSessionFileKey | undefined;
}): Effect.Effect<CliSessionCandidateScan, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const rootInfo = yield* fs.stat(input.sessionsRoot).pipe(Effect.option);
    if (Option.isNone(rootInfo) || rootInfo.value.type !== "Directory") {
      return { rootMissing: true };
    }

    const directoryNames = yield* fs.readDirectory(input.sessionsRoot).pipe(Effect.option);
    const candidateNames = Option.match(directoryNames, {
      onNone: () => [] as Array<string>,
      onSome: (names) => names.filter(input.matchesCandidateDir),
    });

    const files: Array<ScannedCliSessionFile> = [];
    for (const directoryName of candidateNames) {
      const entries = yield* fs
        .readDirectory(path.join(input.sessionsRoot, directoryName))
        .pipe(Effect.option);
      if (Option.isNone(entries)) continue;
      for (const entry of entries.value) {
        // An artifacts directory cannot pass the .jsonl filter; the explicit
        // suffix guard keeps that true even if listing ever becomes recursive.
        if (!entry.endsWith(SESSION_FILE_SUFFIX) || entry.endsWith(ARTIFACTS_DIR_SUFFIX)) {
          continue;
        }
        const sessionPath = path.join(input.sessionsRoot, directoryName, entry);
        const info = yield* fs.stat(sessionPath).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        const modifiedAtMs = Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (mtime) => mtime.getTime(),
        });
        yield* Effect.logDebug("omo.cli-session-catalog.scanned", { sessionPath });
        files.push({ sessionPath, modifiedAtMs });
      }
    }

    files.sort(
      (left, right) =>
        right.modifiedAtMs - left.modifiedAtMs ||
        (left.sessionPath < right.sessionPath ? -1 : left.sessionPath > right.sessionPath ? 1 : 0),
    );

    const after = input.after;
    const visible =
      after === undefined
        ? files
        : files.filter(
            (file) =>
              file.modifiedAtMs < after.modifiedAtMs ||
              (file.modifiedAtMs === after.modifiedAtMs && file.sessionPath > after.sessionPath),
          );
    return { rootMissing: false, files: visible };
  });
