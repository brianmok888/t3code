/**
 * Atomic copy protocol for a session file the omo native CLI owns.
 *
 * Adoption must never be partially observable and must never touch the
 * original. This module owns exactly that: write the bytes to a sibling
 * `<copy>.partial`, fsync it, rename it into place (rename is atomic within a
 * directory), then hash BOTH files and refuse the copy unless the digests are
 * identical. Any failure removes the partial, so the only two states a reader
 * can ever see are "no copy" and "a verified copy".
 *
 * THE SOURCE IS READ-ONLY, ALWAYS. It is opened for reading in bounded
 * `COPY_CHUNK_SIZE` chunks — both to copy it and to hash it — and never
 * written, renamed, truncated or handed to senpi's `SessionManager`, which
 * rewrites a session file in place while migrating it.
 *
 * @module provider/omo/omoCliSessionCopy
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Suffix of the not-yet-verified copy. Never a valid session file. */
export const PARTIAL_COPY_SUFFIX = ".partial";

/** Bound on the bytes resident at once, for both the copy and the hash. */
const COPY_CHUNK_SIZE = 64 * 1024;

/** The copy landed but its bytes are not the source's; the copy was removed. */
export class SessionCopyVerificationFailed extends Schema.TaggedError<SessionCopyVerificationFailed>()(
  "SessionCopyVerificationFailed",
  {
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    sourceSha256: Schema.String,
    copySha256: Schema.String,
  },
) {
  override get message(): string {
    return `copy of ${this.sourcePath} hashed ${this.copySha256}, expected the source digest ${this.sourceSha256}`;
  }
}

/** The copy could not be written, synced or renamed; nothing was left behind. */
export class SessionCopyFailed extends Schema.TaggedError<SessionCopyFailed>()(
  "SessionCopyFailed",
  {
    sourcePath: Schema.String,
    destinationPath: Schema.String,
    stage: Schema.Literals(["read", "write", "sync", "rename", "hash"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `failed to ${this.stage} the adoption copy of ${this.sourcePath}`;
  }
}

export type CliSessionCopyError = SessionCopyFailed | SessionCopyVerificationFailed;

export type CliSessionCopyResult = {
  readonly copyPath: string;
  readonly sha256: string;
  readonly byteSize: number;
};

export type CopyCliSessionFileInput = {
  readonly sourcePath: string;
  readonly destinationPath: string;
  /**
   * Test seam exercised between fsync and rename. Production callers leave it
   * absent; it exists so the digest check can be proven to catch a corrupt
   * copy rather than being assumed to.
   *
   * Every caller reaches the partial through `FileSystem`, so `PlatformError`
   * is the only failure it can produce; naming it keeps the error channel
   * typed instead of `unknown`. Whatever it fails with is folded into the same
   * `SessionCopyFailed({ stage: "write" })` this module already raises.
   */
  readonly onPartialWritten?: (
    partialPath: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
};

/** sha256 of a file, streamed so a large session never lands in memory whole. */
export const hashFile = (
  path: string,
): Effect.Effect<string, SessionCopyFailed, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hash = NodeCrypto.createHash("sha256");
    yield* fs.stream(path, { chunkSize: COPY_CHUNK_SIZE }).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
      Effect.mapError(
        (cause) =>
          new SessionCopyFailed({
            sourcePath: path,
            destinationPath: path,
            stage: "hash",
            cause,
          }),
      ),
    );
    return hash.digest("hex");
  });

const removeQuietly = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(path, { force: true })),
    Effect.ignore,
  );

const failWith =
  (input: CopyCliSessionFileInput, stage: SessionCopyFailed["stage"]) => (cause: unknown) =>
    new SessionCopyFailed({
      sourcePath: input.sourcePath,
      destinationPath: input.destinationPath,
      stage,
      cause,
    });

/**
 * Copy one CLI session file to `destinationPath`, atomically and verifiably.
 *
 * On success the destination exists, is byte-identical to the source, and no
 * `.partial` remains. On ANY failure the destination does not exist and no
 * `.partial` remains — a caller that fails afterwards can therefore delete the
 * copy and be back to a clean state.
 */
export const copyCliSessionFile = (
  input: CopyCliSessionFileInput,
): Effect.Effect<CliSessionCopyResult, CliSessionCopyError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const partialPath = `${input.destinationPath}${PARTIAL_COPY_SUFFIX}`;

    const write = Effect.gen(function* () {
      const file = yield* fs
        .open(partialPath, { flag: "w" })
        .pipe(Effect.mapError(failWith(input, "write")));
      // Streamed in `COPY_CHUNK_SIZE` chunks, exactly like `hashFile`: a
      // session the CLI is still appending to must never be resident whole,
      // and the adoption ceiling is checked at inspect time, before this runs.
      const written = yield* fs.stream(input.sourcePath, { chunkSize: COPY_CHUNK_SIZE }).pipe(
        Stream.mapError(failWith(input, "read")),
        Stream.runFoldEffect(
          () => 0,
          (total, chunk) =>
            file
              .writeAll(chunk)
              .pipe(Effect.mapError(failWith(input, "write")), Effect.as(total + chunk.byteLength)),
        ),
      );
      // fsync BEFORE the rename: a rename that outruns the data write would
      // publish a file whose bytes a crash could still lose.
      yield* file.sync.pipe(Effect.mapError(failWith(input, "sync")));
      return written;
    }).pipe(Effect.scoped);

    const byteSize = yield* write.pipe(Effect.tapCause(() => removeQuietly(partialPath)));

    if (input.onPartialWritten !== undefined) {
      yield* input.onPartialWritten(partialPath).pipe(
        Effect.mapError(failWith(input, "write")),
        Effect.tapCause(() => removeQuietly(partialPath)),
      );
    }

    yield* fs.rename(partialPath, input.destinationPath).pipe(
      Effect.mapError(failWith(input, "rename")),
      Effect.tapCause(() => removeQuietly(partialPath)),
    );

    // Verify AFTER the rename: the digests prove the published file, not an
    // intermediate one, matches the source.
    const verified = Effect.gen(function* () {
      const sourceSha256 = yield* hashFile(input.sourcePath);
      const copySha256 = yield* hashFile(input.destinationPath);
      if (sourceSha256 !== copySha256) {
        return yield* new SessionCopyVerificationFailed({
          sourcePath: input.sourcePath,
          destinationPath: input.destinationPath,
          sourceSha256,
          copySha256,
        });
      }
      return sourceSha256;
    });

    const sha256 = yield* verified.pipe(
      Effect.tapCause(() =>
        removeQuietly(input.destinationPath).pipe(Effect.andThen(removeQuietly(partialPath))),
      ),
    );

    return { copyPath: input.destinationPath, sha256, byteSize } satisfies CliSessionCopyResult;
  });

/**
 * Remove `*.partial` leftovers from a session directory.
 *
 * A partial can only survive a crash between write and rename, and it is never
 * a readable session, so deleting it is always safe. Returns what was removed
 * so a caller can log it.
 */
export const sweepPartialSessionCopies = (
  directory: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const removed: Array<string> = [];
    for (const entry of entries) {
      if (!entry.endsWith(PARTIAL_COPY_SUFFIX)) continue;
      const partialPath = path.join(directory, entry);
      yield* removeQuietly(partialPath);
      removed.push(partialPath);
    }
    return removed;
  });
