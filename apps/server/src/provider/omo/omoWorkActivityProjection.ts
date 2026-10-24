/**
 * start-work (boulder) + ultrawork activity projection.
 *
 * Two independent signals, one module because both answer "what long-running
 * omo work is this environment/thread inside?":
 *
 * 1. `<projectDir>/.omo/boulder.json` — omo's boulder state (schema_version 2,
 *    `works` keyed by work id). The decode is deliberately LENIENT rather than
 *    a `Schema` decode: the live file in this repository carries
 *    `"status": "complete"` while omo's own `boulder-state/src/types.ts`
 *    declares `"completed"`, and every writer keeps adding keys
 *    (`delivery_mode`, `wave_branches`, `prs`, ...). A strict decode would
 *    reject the real file outright, so unknown keys pass through ignored and
 *    an unrecognized status skips only THAT record.
 * 2. omo session entries — an `omo-ultrawork:directive` custom message
 *    (omo `packages/omo-omo/src/components/ultrawork/index.ts`) proves
 *    ultrawork mode was armed for the session. Detection is HYDRATION-ONLY by
 *    design: a loop armed mid-session badges only after the thread is
 *    re-hydrated, and a session whose replay never carries the type simply
 *    ships without the badge — no scraping heuristics.
 *
 * @module provider/omo/omoWorkActivityProjection
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { omoWatchTicks } from "./omoAgentSettings.ts";

const BOULDER_STATE_DIR = ".omo";
const BOULDER_STATE_FILE = "boulder.json";
const OMO_SESSION_ID_PREFIX = "omo:";
const ULTRAWORK_CUSTOM_TYPE = "omo-ultrawork:directive";

/** `complete` is the value the real file writes; `completed` is the typed literal. */
const COMPLETED_STATUSES = new Set(["complete", "completed"]);
const ACTIVE_STATUS = "active";

export type OmoActiveWork = {
  readonly workId: string;
  readonly planName: string;
  readonly status: "active";
  readonly worktreePath?: string;
  readonly sessionIds: ReadonlyArray<string>;
};

export type OmoWorkActivitySummary = {
  readonly activeWorks: ReadonlyArray<OmoActiveWork>;
};

const EMPTY_SUMMARY: OmoWorkActivitySummary = { activeWorks: [] };

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const stringArrayField = (
  record: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
};

/**
 * Strips the `omo:` prefix so ids join against thread durable session ids.
 * Foreign prefixes (`codex:`) stay untouched — they belong to other harnesses
 * and must not be mangled into a omo id. A bare `omo:` yields nothing.
 */
export const omoDurableSessionIds = (sessionIds: ReadonlyArray<string>): ReadonlyArray<string> =>
  sessionIds
    .map((sessionId) =>
      sessionId.startsWith(OMO_SESSION_ID_PREFIX)
        ? sessionId.slice(OMO_SESSION_ID_PREFIX.length)
        : sessionId,
    )
    .filter((sessionId) => sessionId.length > 0);

const projectWork = (workId: string, raw: unknown): OmoActiveWork | undefined => {
  if (!isRecord(raw)) return undefined;
  const status = stringField(raw, "status");
  if (status === undefined || COMPLETED_STATUSES.has(status) || status !== ACTIVE_STATUS) {
    return undefined;
  }
  const resolvedWorkId = stringField(raw, "work_id") ?? workId;
  const planName = stringField(raw, "plan_name") ?? resolvedWorkId;
  const worktreePath = stringField(raw, "worktree_path");
  return {
    workId: resolvedWorkId,
    planName,
    status: ACTIVE_STATUS,
    ...(worktreePath === undefined ? {} : { worktreePath }),
    sessionIds: omoDurableSessionIds(stringArrayField(raw, "session_ids")),
  };
};

/**
 * Folds a parsed boulder document into the environment-level activity
 * summary. Anything unusable — a non-object document, a non-object `works`,
 * a record with a paused/abandoned/completed/unknown/missing status —
 * contributes nothing, and never fails the whole projection.
 */
export const projectOmoWorkActivity = (raw: unknown): OmoWorkActivitySummary => {
  if (!isRecord(raw)) return EMPTY_SUMMARY;
  const works = raw.works;
  if (!isRecord(works)) return EMPTY_SUMMARY;
  const activeWorks: Array<OmoActiveWork> = [];
  for (const [workId, value] of Object.entries(works)) {
    const projected = projectWork(workId, value);
    if (projected !== undefined) activeWorks.push(projected);
  }
  return { activeWorks };
};

export const omoBoulderStatePath = (projectDir: string): Effect.Effect<string, never, Path.Path> =>
  Effect.map(Path.Path, (path) => path.join(projectDir, BOULDER_STATE_DIR, BOULDER_STATE_FILE));

/**
 * Lenient read of `<projectDir>/.omo/boulder.json`: a missing, unreadable, or
 * unparseable file degrades to the empty summary, matching the plan's rule
 * that an absent boulder file is the normal state for a project that never
 * ran start-work.
 */
export const readOmoWorkActivity = (
  projectDir: string,
): Effect.Effect<OmoWorkActivitySummary, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const statePath = yield* omoBoulderStatePath(projectDir);
    const raw = yield* fs.readFileString(statePath).pipe(Effect.option);
    if (Option.isNone(raw)) return EMPTY_SUMMARY;
    const parsed = decodeJson(raw.value);
    if (Result.isFailure(parsed)) return EMPTY_SUMMARY;
    return projectOmoWorkActivity(parsed.success);
  });

/**
 * Attach tick + one debounced tick per change under `<projectDir>/.omo`,
 * each re-reading the boulder file leniently. The directory is created
 * best-effort first because `fs.watch` fails on a missing path and
 * `omoWatchTicks` degrades that failure to "attach tick only" — a project
 * that has not run start-work yet is the normal first state, and it must
 * still pick the file up once start-work writes it. Ticks are unfiltered on
 * purpose: platform watchers report child writes variously as
 * directory-level updates, create/remove pairs, or renames.
 */
export const watchOmoWorkActivity = (
  projectDir: string,
): Stream.Stream<OmoWorkActivitySummary, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = path.join(projectDir, BOULDER_STATE_DIR);
      yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
      return omoWatchTicks(fs.watch(stateDir)).pipe(
        Stream.mapEffect(() => readOmoWorkActivity(projectDir)),
      );
    }),
  );

const carriesUltraworkDirective = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.customType === ULTRAWORK_CUSTOM_TYPE) return true;
  return isRecord(value.message) && value.message.customType === ULTRAWORK_CUSTOM_TYPE;
};

/**
 * Hydration-only ultrawork badge source: true when a replayed entry carries
 * the `omo-ultrawork:directive` custom type, either as a `custom_message`
 * entry or as a `role: "custom"` message entry (omo persists the directive
 * one way and replays it the other depending on storage backend).
 */
export const detectOmoUlwActive = (entries: ReadonlyArray<unknown>): boolean =>
  entries.some(carriesUltraworkDirective);
