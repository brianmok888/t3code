// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SANITIZED_PREFIX_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 32;

export const sanitizeSegment = (value: string): string => {
  const prefix = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, SANITIZED_PREFIX_LENGTH);
  const hash = NodeCrypto.createHash("sha256").update(value).digest("hex");
  return `${prefix}-${hash.slice(0, HASH_SUFFIX_LENGTH)}`;
};

export const resolveOmoSessionDir = (stateDir: string, instanceId: string): string =>
  NodePath.join(stateDir, "omo-sessions", sanitizeSegment(instanceId));

export const initializeOmoSessionLayout = Effect.fn("OmoSessionLayout.initialize")(function* (
  stateDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const legacyDirectory = NodePath.join(stateDir, "senpi-sessions");
  const canonicalDirectory = NodePath.join(stateDir, "omo-sessions");
  if ((yield* fs.exists(legacyDirectory)) && !(yield* fs.exists(canonicalDirectory))) {
    yield* fs.rename(legacyDirectory, canonicalDirectory);
  }
});

export const omoSessionFilePath = (
  directory: string,
  threadId: string,
  epochMillis: number,
  sequence: number,
): string =>
  NodePath.join(directory, `thread-${sanitizeSegment(threadId)}-${epochMillis}-${sequence}.jsonl`);

export const makeOmoSessionFilePathAllocator = () => {
  let sequence = 0;
  return Effect.fn("OmoSessionLayout.allocateSessionFile")(function* (
    directory: string,
    threadId: string,
  ) {
    const epochMillis = yield* Clock.currentTimeMillis;
    const currentSequence = sequence;
    sequence += 1;
    return omoSessionFilePath(directory, threadId, epochMillis, currentSequence);
  });
};

export const ensureOmoSessionDir = Effect.fn("OmoSessionLayout.ensureDirectory")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
});

export const isPathInsideOmoSessionDir = Effect.fn("OmoSessionLayout.isPathInside")(function* (
  directory: string,
  candidate: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalDirectory = yield* fs.realPath(directory);
  const resolvedCandidate = path.resolve(candidate);
  const candidateExists = yield* fs.exists(resolvedCandidate);
  const canonicalCandidate = candidateExists
    ? yield* fs.realPath(resolvedCandidate)
    : path.join(
        yield* fs.realPath(path.dirname(resolvedCandidate)),
        path.basename(resolvedCandidate),
      );
  const relative = path.relative(canonicalDirectory, canonicalCandidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
});
