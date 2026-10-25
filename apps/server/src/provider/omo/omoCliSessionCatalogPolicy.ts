/**
 * Status policy for the CLI session catalog: what suppresses a row, what wins
 * when rules collide, and how duplicate header ids resolve.
 *
 * This module owns the row/status SHAPES plus every decision rule that turns a
 * matched candidate into a row — provenance precedence, both desktop-origin
 * suppression rules, defect surfacing and duplicate-id resolution. The scan and
 * the orchestration live in `omoCliSessionCatalogScan.ts` and
 * `omoCliSessionCatalog.ts`.
 *
 * PRECEDENCE is the load-bearing rule: adopted-session provenance by
 * source_path is checked FIRST and WINS over id-based suppression, because an
 * adopted copy shares its source's header id by construction — checking ids
 * first would make every adopted source vanish from the list.
 *
 * @module provider/omo/omoCliSessionCatalogPolicy
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  AdoptedSessionProvenanceService,
  AdoptedSessionProvenanceRepositoryError,
} from "../../persistence/Services/AdoptedSessionProvenance.ts";
import type { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import type { ProviderSessionRuntimeRepositoryError } from "../../persistence/Errors.ts";
import { isPathInsideOmoSessionDir } from "../Drivers/OmoSessionLayout.ts";
import type { CliSessionDefect } from "./omoCliSessionErrors.ts";
import type { CliSessionInspection, CliSessionMessageCounts } from "./omoCliSessionInspector.ts";
import {
  hashCliSessionFileSha256,
  type ScannedCliSessionFile,
} from "./omoCliSessionCatalogScan.ts";

export type CliSessionCatalogStatus =
  | { readonly kind: "adoptable" }
  | { readonly kind: "defective"; readonly reasons: ReadonlyArray<CliSessionDefect> }
  | { readonly kind: "alreadyAdopted"; readonly existingThreadId: string }
  | { readonly kind: "duplicateAlias"; readonly ofSessionPath: string }
  | { readonly kind: "conflict"; readonly withSessionPath: string };

export type CliSessionCatalogRow = {
  readonly sessionPath: string;
  readonly sessionId: string | null;
  /** Path of the session's cwd relative to the workspace root; null when at the root. */
  readonly cwdSubpath: string | null;
  readonly parentSessionId: string | null;
  readonly modifiedAtMs: number;
  readonly entryCount: number;
  readonly messageCounts: CliSessionMessageCounts;
  readonly sessionName: string | null;
  readonly lastProvider: string | null;
  readonly lastModel: string | null;
  readonly lastTimestamp: string | null;
  readonly multiLeaf: boolean;
  readonly tornFinalLine: boolean;
  readonly status: CliSessionCatalogStatus;
};

/** One candidate that survived the authoritative cwd match and was inspected. */
export type CliSessionCandidate = {
  readonly file: ScannedCliSessionFile;
  readonly subpath: string | null;
  readonly inspection: CliSessionInspection;
};

/** Session ids the desktop itself resumed, read ONCE per list call. */
const ResumeCursorSessionId = Schema.Struct({ sessionId: Schema.String });
const decodeResumeCursorSessionId = Schema.decodeUnknownResult(ResumeCursorSessionId);

/**
 * Ids of sessions the desktop originated, from
 * `provider_session_runtime.resume_cursor_json` (`{threadId, sessionFile,
 * sessionId}`). NEVER `projection_thread_sessions.provider_session_id`: that
 * column is declared but never written by its only writer, so checking it
 * silently matches nothing.
 */
export const readDesktopSessionIds = (
  runtimes: ProviderSessionRuntimeRepository["Service"],
): Effect.Effect<ReadonlySet<string>, ProviderSessionRuntimeRepositoryError> =>
  Effect.gen(function* () {
    const ids = new Set<string>();
    for (const row of yield* runtimes.list()) {
      const decoded = decodeResumeCursorSessionId(row.resumeCursor);
      if (Result.isSuccess(decoded)) ids.add(decoded.success.sessionId);
    }
    return ids;
  });

const defectiveReasons = (inspection: CliSessionInspection): ReadonlyArray<CliSessionDefect> => {
  const defects = inspection.defects;
  const reasons: Array<CliSessionDefect> = [];
  if (defects.missingHeader) reasons.push("missing_header");
  if (defects.malformedInteriorLines.length > 0) reasons.push("malformed_interior_line");
  if (defects.duplicateEntryIds.length > 0) reasons.push("duplicate_entry_id");
  if (defects.unknownParentIds.length > 0) reasons.push("unknown_parent_id");
  if (defects.cycles.length > 0) reasons.push("parent_cycle");
  if (defects.unsupportedVersion) reasons.push("unsupported_version");
  return reasons;
};

export type CliSessionClassification =
  | { readonly render: false }
  | { readonly render: true; readonly status: CliSessionCatalogStatus };

export type CliSessionClassificationDeps = {
  readonly provenance: AdoptedSessionProvenanceService;
  readonly omoSessionDirs: ReadonlyArray<string>;
  readonly desktopSessionIds: ReadonlySet<string>;
};

/**
 * Apply the precedence chain to one matched candidate: provenance first, then
 * path-inside-an-omo-instance-dir, then desktop-resumed header id, then defects.
 */
export const classifyCliSessionCandidate = (
  candidate: CliSessionCandidate,
  deps: CliSessionClassificationDeps,
): Effect.Effect<
  CliSessionClassification,
  AdoptedSessionProvenanceRepositoryError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const adopted = yield* deps.provenance.findBySourcePath({
      sourcePath: candidate.file.sessionPath,
    });
    if (Option.isSome(adopted)) {
      return {
        render: true,
        status: { kind: "alreadyAdopted", existingThreadId: adopted.value.threadId },
      };
    }
    for (const directory of deps.omoSessionDirs) {
      const inside = yield* isPathInsideOmoSessionDir(directory, candidate.file.sessionPath).pipe(
        Effect.orElseSucceed(() => false),
      );
      if (inside) return { render: false };
    }
    const sessionId = candidate.inspection.sessionId;
    if (sessionId !== null && deps.desktopSessionIds.has(sessionId)) return { render: false };
    const reasons = defectiveReasons(candidate.inspection);
    return reasons.length > 0
      ? { render: true, status: { kind: "defective", reasons } }
      : { render: true, status: { kind: "adoptable" } };
  });

/**
 * Resolve duplicate header ids among the collected rows. Identical content
 * keeps one adoptable row and aliases the rest; divergent content marks EVERY
 * copy conflicting and is never resolved by mtime or filename. Only adoptable
 * rows participate — an already-adopted or defective row keeps its status.
 *
 * Resolution is scoped to one page's collected rows: a duplicate pair split
 * across a page boundary is the price of bounded per-page work.
 */
export const resolveDuplicateSessionIds = (
  rows: ReadonlyArray<CliSessionCatalogRow>,
): Effect.Effect<ReadonlyArray<CliSessionCatalogRow>, never, FileSystem.FileSystem> => {
  const groups = new Map<string, Array<CliSessionCatalogRow>>();
  for (const row of rows) {
    if (row.sessionId === null || row.status.kind !== "adoptable") continue;
    const group = groups.get(row.sessionId);
    if (group === undefined) groups.set(row.sessionId, [row]);
    else group.push(row);
  }
  return Effect.gen(function* () {
    const rewrites = new Map<CliSessionCatalogRow, CliSessionCatalogStatus>();
    for (const group of groups.values()) {
      const primary = group[0];
      if (group.length < 2 || primary === undefined) continue;
      const hashes = yield* Effect.forEach(group, (row) =>
        hashCliSessionFileSha256(row.sessionPath),
      );
      const firstHash = hashes[0];
      // Unreadable content can never PROVE identity, so it counts as divergent.
      const identical =
        firstHash !== undefined &&
        Option.isSome(firstHash) &&
        hashes.every((hash) => Option.isSome(hash) && hash.value === firstHash.value);
      if (identical) {
        for (const row of group.slice(1)) {
          rewrites.set(row, { kind: "duplicateAlias", ofSessionPath: primary.sessionPath });
        }
      } else {
        const other = group[1] ?? primary;
        rewrites.set(primary, { kind: "conflict", withSessionPath: other.sessionPath });
        for (const row of group.slice(1)) {
          rewrites.set(row, { kind: "conflict", withSessionPath: primary.sessionPath });
        }
      }
    }
    return rows.map((row) => {
      const status = rewrites.get(row);
      return status === undefined ? row : { ...row, status };
    });
  });
};
