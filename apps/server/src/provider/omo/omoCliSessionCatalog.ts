/**
 * Catalog of omo-native-CLI sessions available for adoption, for one workspace.
 *
 * The scan is cheapest-first and bounded: stat every candidate file, sort by
 * mtime, then inspect LAZILY in that order until one page of qualifying rows is
 * collected — a workspace rooted at $HOME prefilters to 1400+ candidate files,
 * and inspecting all of them would cost seconds per page. The authoritative
 * project match happens on the header's `cwd` under `realpath` on BOTH sides
 * (`normalizeWorkspaceRoot` does not realpath, and six of this user's real
 * projects only match through a symlinked ancestor).
 *
 * PRIVACY is load-bearing: only the header line of a candidate is read before
 * the match, so a non-matching session's names never enter memory.
 *
 * @module provider/omo/omoCliSessionCatalog
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProviderSessionRuntimeRepositoryError } from "../../persistence/Errors.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { inspectCliSessionFile } from "./omoCliSessionInspector.ts";
import { candidateDirsForWorkspaceRoot, resolveCliSessionsRoot } from "./omoCliSessionStore.ts";
import {
  peekCliSessionHeader,
  scanCliSessionCandidates,
  type CliSessionFileKey,
  type ScannedCliSessionFile,
} from "./omoCliSessionCatalogScan.ts";
import { AdoptedSessionProvenanceRepository } from "../../persistence/Services/AdoptedSessionProvenance.ts";
import {
  classifyCliSessionCandidate,
  readDesktopSessionIds,
  resolveDuplicateSessionIds,
  type CliSessionCandidate,
  type CliSessionCatalogRow,
  type CliSessionCatalogStatus,
} from "./omoCliSessionCatalogPolicy.ts";

/** Inspections per batch; the only overshoot a page can incur is one batch. */
const INSPECT_CONCURRENCY = 8;
const DEFAULT_PAGE_SIZE = 50;

export type CliSessionCatalogCursor = CliSessionFileKey;

export type ListCliSessionsOptions = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cursor?: CliSessionCatalogCursor | undefined;
  /** Omo instance session directories; rows resolving inside them are desktop-origin. */
  readonly omoSessionDirs?: ReadonlyArray<string> | undefined;
  readonly inspectFile?: typeof inspectCliSessionFile | undefined;
  readonly pageSize?: number | undefined;
};

export type CliSessionCatalogResult =
  | { readonly kind: "cli-store-absent" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "sessions";
      readonly rows: ReadonlyArray<CliSessionCatalogRow>;
      readonly nextCursor?: CliSessionCatalogCursor;
    };

/** Header-peek, then the authoritative realpath match, and only then inspect. */
const collectCandidate = (
  file: ScannedCliSessionFile,
  realWorkspaceRoot: string,
  inspectFile: typeof inspectCliSessionFile,
): Effect.Effect<CliSessionCandidate | null, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const header = yield* peekCliSessionHeader(file.sessionPath);
    const headerCwd = header.cwd;
    if (headerCwd === null) return null;
    const realCwd = yield* fs
      .realPath(headerCwd)
      .pipe(Effect.orElseSucceed(() => path.resolve(headerCwd)));

    let subpath: string | null;
    if (realCwd === realWorkspaceRoot) {
      subpath = null;
    } else {
      const relative = path.relative(realWorkspaceRoot, realCwd);
      const escapes =
        relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      if (escapes) return null;
      subpath = relative.split(path.sep).join("/");
    }

    const inspection = yield* inspectFile(file.sessionPath).pipe(Effect.option);
    if (Option.isNone(inspection)) return null;
    return { file, subpath, inspection: inspection.value };
  });

const buildRow = (
  candidate: CliSessionCandidate,
  status: CliSessionCatalogStatus,
): CliSessionCatalogRow => {
  const inspection = candidate.inspection;
  return {
    sessionPath: candidate.file.sessionPath,
    sessionId: inspection.sessionId,
    cwdSubpath: candidate.subpath,
    parentSessionId: inspection.parentSessionId,
    modifiedAtMs: candidate.file.modifiedAtMs,
    entryCount: inspection.entryCount,
    messageCounts: inspection.messageCounts,
    sessionName: inspection.sessionName,
    lastProvider: inspection.lastProvider,
    lastModel: inspection.lastModel,
    lastTimestamp: inspection.lastTimestamp,
    multiLeaf: inspection.multiLeaf,
    tornFinalLine: inspection.defects.tornFinalLine,
    status,
  };
};

/**
 * List this workspace's adoptable CLI sessions, newest first.
 *
 * Never writes, and never recurses outside the candidate directories the store
 * locator's (deliberately over-matching) prefilter selects.
 */
export const listCliSessions = (
  workspaceRoot: string,
  options: ListCliSessionsOptions,
): Effect.Effect<
  CliSessionCatalogResult,
  ProviderSessionRuntimeRepositoryError,
  | FileSystem.FileSystem
  | Path.Path
  | ProviderSessionRuntimeRepository
  | AdoptedSessionProvenanceRepository
> =>
  // opaque E/R leak from low-level parse helpers; the annotation above is the
  // contract — cast documented here rather than threaded through every helper.
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtimes = yield* ProviderSessionRuntimeRepository;
    const provenance = yield* AdoptedSessionProvenanceRepository;

    const sessionsRoot = yield* resolveCliSessionsRoot(options.environment, workspaceRoot);
    const realWorkspaceRoot = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => path.resolve(workspaceRoot)));
    const matchesCandidateDir = yield* candidateDirsForWorkspaceRoot(workspaceRoot);

    const scan = yield* scanCliSessionCandidates({
      sessionsRoot,
      matchesCandidateDir,
      after: options.cursor,
    });
    if (scan.rootMissing) return { kind: "cli-store-absent" };
    if (scan.files.length === 0) return { kind: "empty" };

    const deps = {
      provenance,
      omoSessionDirs: options.omoSessionDirs ?? [],
      desktopSessionIds: yield* readDesktopSessionIds(runtimes),
    };
    const inspectFile = options.inspectFile ?? inspectCliSessionFile;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

    const collected: Array<CliSessionCatalogRow> = [];
    let lastEmitted: ScannedCliSessionFile | undefined;
    for (
      let start = 0;
      start < scan.files.length && collected.length < pageSize;
      start += INSPECT_CONCURRENCY
    ) {
      const batch = scan.files.slice(start, start + INSPECT_CONCURRENCY);
      const found = yield* Effect.forEach(
        batch,
        (file) => collectCandidate(file, realWorkspaceRoot, inspectFile),
        { concurrency: INSPECT_CONCURRENCY },
      );
      for (const [index, file] of batch.entries()) {
        if (collected.length >= pageSize) break;
        const candidate = found[index];
        if (candidate === null || candidate === undefined) continue;
        const classified = yield* classifyCliSessionCandidate(candidate, deps);
        if (!classified.render) continue;
        collected.push(buildRow(candidate, classified.status));
        lastEmitted = file;
      }
    }

    if (collected.length === 0) return { kind: "empty" };
    const rows = yield* resolveDuplicateSessionIds(collected);
    return {
      kind: "sessions",
      rows,
      ...(collected.length === pageSize && lastEmitted !== undefined
        ? {
            nextCursor: {
              modifiedAtMs: lastEmitted.modifiedAtMs,
              sessionPath: lastEmitted.sessionPath,
            },
          }
        : {}),
    };
  }) as unknown as Effect.Effect<
    CliSessionCatalogResult,
    ProviderSessionRuntimeRepositoryError,
    | FileSystem.FileSystem
    | Path.Path
    | ProviderSessionRuntimeRepository
    | AdoptedSessionProvenanceRepository
  >;
