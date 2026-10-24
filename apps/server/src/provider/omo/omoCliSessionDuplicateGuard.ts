/**
 * Deciding whether a session file's header id is unambiguously ITS id.
 *
 * A session id is copied whenever a file is: `cp`, a restored backup, a synced
 * folder. Two files can therefore hold the same header id, and adoption has to
 * decide which one the id names BEFORE it copies anything.
 *
 * THE RULE: identical bytes are an alias (adopting either loses nothing);
 * different bytes are a CONFLICT and block both. Recency and filename are never
 * tie-breakers — the losing file would be a conversation silently discarded on
 * a heuristic. An unreadable twin is divergent too: two failed reads must not
 * hash to the same nothing and "prove" an identity (`hashCliSessionFileSha256`
 * returns `None` exactly so this stays decidable).
 *
 * Scope is the file's OWN directory: senpi stores one cwd's sessions together,
 * so that is where a copy lands, and it bounds the work to one listing.
 *
 * @module provider/omo/omoCliSessionDuplicateGuard
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { hashCliSessionFileSha256, peekCliSessionHeader } from "./omoCliSessionCatalogScan.ts";

const SESSION_FILE_SUFFIX = ".jsonl";
const ARTIFACTS_DIR_SUFFIX = "-artifacts";

export type CliSessionDuplicateVerdict =
  /** No other file in the directory claims this header id. */
  | { readonly kind: "unique" }
  /** Byte-identical twins; adopting this file is safe. */
  | { readonly kind: "alias"; readonly aliasPaths: ReadonlyArray<string> }
  /** A twin with different (or unprovable) content; adoption is blocked. */
  | { readonly kind: "conflict"; readonly conflictingSessionPath: string };

export type ResolveCliSessionDuplicatesInput = {
  readonly sessionPath: string;
  /** The header id read from `sessionPath`; a null id can never be duplicated. */
  readonly sessionId: string | null;
  /**
   * Digest source, defaulting to the real one. Overridden only to prove the
   * unprovable-identity rule, which a real filesystem cannot express: a file
   * readable enough to peek but not to hash.
   */
  readonly hashFile?: typeof hashCliSessionFileSha256;
};

/** Sibling `*.jsonl` files whose header id matches, sorted for a stable verdict. */
const twinsOf = (
  sessionPath: string,
  sessionId: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.dirname(sessionPath);
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));

    const twins: Array<string> = [];
    for (const entry of entries) {
      if (!entry.endsWith(SESSION_FILE_SUFFIX) || entry.endsWith(ARTIFACTS_DIR_SUFFIX)) continue;
      const candidate = path.join(directory, entry);
      if (candidate === sessionPath) continue;
      const header = yield* peekCliSessionHeader(candidate);
      if (header.id === sessionId) twins.push(candidate);
    }
    return twins.toSorted();
  });

/**
 * Classify one session file against the other files claiming its header id.
 *
 * Never reads a twin's entries — only its header line and its digest — so a
 * conflicting session's content never enters memory.
 */
export const resolveCliSessionDuplicates = (
  input: ResolveCliSessionDuplicatesInput,
): Effect.Effect<CliSessionDuplicateVerdict, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const sessionId = input.sessionId;
    if (sessionId === null) return { kind: "unique" };

    const twins = yield* twinsOf(input.sessionPath, sessionId);
    const firstTwin = twins[0];
    if (firstTwin === undefined) return { kind: "unique" };

    const hashFile = input.hashFile ?? hashCliSessionFileSha256;
    const ownHash = yield* hashFile(input.sessionPath);
    for (const twin of twins) {
      const twinHash = yield* hashFile(twin);
      const identical =
        Option.isSome(ownHash) && Option.isSome(twinHash) && ownHash.value === twinHash.value;
      if (!identical) return { kind: "conflict", conflictingSessionPath: twin };
    }
    return { kind: "alias", aliasPaths: twins };
  });
