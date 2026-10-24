/**
 * Tree analysis over the entries of an omo CLI session file.
 *
 * This module owns ONE concept: the `id`/`parentId` graph
 * (`core/session-manager.d.ts:19-127`). It never touches the filesystem — it
 * takes the entries `omoCliSessionReader.ts` produced and answers which lineage
 * the CLI would resume, how many leaves exist, which model that lineage ends
 * on, and which structural defects make the tree untrustworthy.
 *
 * HEAD RULE (the load-bearing rule here) — replicated from senpi
 * `core/session-manager.js:155-175`: `buildSessionPath` takes
 * `entries[entries.length - 1]` as the leaf, i.e. the LAST entry in FILE ORDER
 * and NOT a graph-derived leaf, then walks `parentId` to the root and reverses.
 * On a branched file the last line can sit on the SHORTER branch; choosing the
 * deepest leaf instead would resume a different conversation than the CLI does.
 *
 * @module provider/omo/omoCliSessionGraph
 */
import type { CliSessionEntry } from "./omoCliSessionReader.ts";

/** Structural problems visible only once the entries are seen as a tree. */
export type CliSessionGraphDefects = {
  readonly duplicateEntryIds: ReadonlyArray<string>;
  readonly unknownParentIds: ReadonlyArray<string>;
  readonly cycles: ReadonlyArray<string>;
};

export type CliSessionGraph = {
  /** Ordered entry ids from root to the current leaf. */
  readonly currentLeafPath: ReadonlyArray<string>;
  readonly multiLeaf: boolean;
  readonly lastProvider: string | null;
  readonly lastModel: string | null;
  readonly defects: CliSessionGraphDefects;
};

/**
 * Index entries by id, reporting ids claimed more than once.
 *
 * First writer wins so the index stays deterministic, but a duplicate makes the
 * tree ambiguous and is reported: two entries claiming one id means `parentId`
 * no longer names a unique parent.
 */
const indexEntries = (
  entries: ReadonlyArray<CliSessionEntry>,
): {
  readonly byId: ReadonlyMap<string, CliSessionEntry>;
  readonly duplicateEntryIds: ReadonlyArray<string>;
} => {
  const byId = new Map<string, CliSessionEntry>();
  const duplicateEntryIds: Array<string> = [];
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      if (!duplicateEntryIds.includes(entry.id)) duplicateEntryIds.push(entry.id);
      continue;
    }
    byId.set(entry.id, entry);
  }
  return { byId, duplicateEntryIds };
};

/**
 * Walk from the last entry in FILE ORDER up to the root and reverse — the head
 * rule, verified in `core/session-manager.js:155-175`.
 *
 * The walk is cycle-guarded because a hand-edited file can point two entries at
 * each other: senpi would spin, we stop and report the id we re-entered.
 */
const buildLeafPath = (
  entries: ReadonlyArray<CliSessionEntry>,
  byId: ReadonlyMap<string, CliSessionEntry>,
): { readonly path: ReadonlyArray<string>; readonly cycles: ReadonlyArray<string> } => {
  const leaf = entries[entries.length - 1];
  if (leaf === undefined) return { path: [], cycles: [] };

  const path: Array<string> = [];
  const seen = new Set<string>();
  const cycles: Array<string> = [];
  let current: CliSessionEntry | undefined = leaf;
  while (current !== undefined) {
    if (seen.has(current.id)) {
      cycles.push(current.id);
      break;
    }
    seen.add(current.id);
    path.push(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  path.reverse();
  return { path, cycles };
};

/** Every id referenced as a parent but never defined by a line in the file. */
const collectUnknownParentIds = (
  entries: ReadonlyArray<CliSessionEntry>,
  byId: ReadonlyMap<string, CliSessionEntry>,
): ReadonlyArray<string> => {
  const unknown: Array<string> = [];
  for (const entry of entries) {
    if (entry.parentId === null) continue;
    if (byId.has(entry.parentId)) continue;
    if (unknown.includes(entry.parentId)) continue;
    unknown.push(entry.parentId);
  }
  return unknown;
};

/**
 * The last `model_change` ON THE CURRENT LEAF PATH, which is the model the CLI
 * would resume with. A `model_change` on an abandoned branch must not leak into
 * the answer, so entries off the path are skipped even when they are newer.
 */
const lastModelOnPath = (
  entries: ReadonlyArray<CliSessionEntry>,
  path: ReadonlyArray<string>,
): { readonly provider: string | null; readonly modelId: string | null } => {
  const onPath = new Set(path);
  let provider: string | null = null;
  let modelId: string | null = null;
  for (const entry of entries) {
    if (entry.type !== "model_change" || !onPath.has(entry.id)) continue;
    provider = entry.provider ?? null;
    modelId = entry.modelId ?? null;
  }
  return { provider, modelId };
};

/** An entry no other entry claims as a parent is a leaf; two or more means the session branched. */
const countLeaves = (entries: ReadonlyArray<CliSessionEntry>): number => {
  const parented = new Set(
    entries.flatMap((entry) => (entry.parentId === null ? [] : [entry.parentId])),
  );
  return entries.filter((entry) => !parented.has(entry.id)).length;
};

export const analyzeCliSessionGraph = (
  entries: ReadonlyArray<CliSessionEntry>,
): CliSessionGraph => {
  const { byId, duplicateEntryIds } = indexEntries(entries);
  const { path, cycles } = buildLeafPath(entries, byId);
  const model = lastModelOnPath(entries, path);

  return {
    currentLeafPath: path,
    multiLeaf: countLeaves(entries) > 1,
    lastProvider: model.provider,
    lastModel: model.modelId,
    defects: {
      duplicateEntryIds,
      unknownParentIds: collectUnknownParentIds(entries, byId),
      cycles,
    },
  };
};
