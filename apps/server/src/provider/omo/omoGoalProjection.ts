// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { ThreadGoal, type ThreadGoal as ThreadGoalValue } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { omoWatchTicks } from "./omoAgentSettings.ts";

const OmoGoalFile = Schema.Struct({
  version: Schema.Literal(1),
  goal: Schema.NullOr(ThreadGoal),
});

const decodeOmoGoalFile = Schema.decodeUnknownResult(Schema.fromJsonString(OmoGoalFile));

type OmoGoalFileState =
  | { readonly source: "file"; readonly goal: ThreadGoalValue | null }
  | { readonly source: "missing"; readonly goal: null };
type OmoGoalReadResult =
  | { readonly kind: "emit"; readonly state: OmoGoalFileState }
  | { readonly kind: "skip" };

export type OmoGoalControl =
  | { readonly type: "goal.pause" }
  | { readonly type: "goal.resume" }
  | { readonly type: "goal.clear" }
  | { readonly type: "goal.setObjective"; readonly objective: string };

export type OmoGoalFileLocation = {
  readonly directory: string;
  readonly path: string;
};

export const resolveOmoGoalFile = (
  sessionFile: string,
  durableSessionId: string,
): OmoGoalFileLocation => {
  const directory = NodePath.join(NodePath.dirname(sessionFile), "extensions", "goal");
  return {
    directory,
    path: NodePath.join(directory, `${encodeURIComponent(durableSessionId)}.json`),
  };
};

export const goalControlPrompt = (control: OmoGoalControl): string => {
  switch (control.type) {
    case "goal.pause":
      return "/goal pause";
    case "goal.resume":
      return "/goal resume";
    case "goal.clear":
      return "/goal clear";
    case "goal.setObjective":
      return `/goal ${control.objective.trim()}`;
  }
};

const sameGoalState = (left: OmoGoalFileState, right: OmoGoalFileState): boolean =>
  left.source === right.source && JSON.stringify(left.goal) === JSON.stringify(right.goal);

const readGoalState = (input: {
  readonly path: string;
  readonly onMalformed: (cause: unknown) => Effect.Effect<void>;
  readonly emitMissing: boolean;
}): Effect.Effect<OmoGoalReadResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(input.path).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return input.emitMissing
        ? ({ kind: "emit", state: { source: "missing", goal: null } } as const)
        : ({ kind: "skip" } as const);
    }
    const raw = yield* fs.readFileString(input.path).pipe(Effect.result);
    if (Result.isFailure(raw)) {
      return { kind: "emit", state: { source: "missing", goal: null } } as const;
    }
    const decoded = decodeOmoGoalFile(raw.success);
    if (Result.isFailure(decoded)) {
      yield* input.onMalformed(decoded.failure);
      return { kind: "skip" } as const;
    }
    return {
      kind: "emit",
      state: { source: "file", goal: decoded.success.goal },
    } as const;
  });

export const projectOmoGoalTicks = <E, R>(input: {
  readonly location: OmoGoalFileLocation;
  readonly ticks: Stream.Stream<unknown, E, R>;
  readonly onMalformed?: (cause: unknown) => Effect.Effect<void>;
}): Stream.Stream<ThreadGoalValue | null, never, FileSystem.FileSystem | R> => {
  const onMalformed =
    input.onMalformed ??
    ((cause: unknown) =>
      Effect.logWarning("omo goal file is malformed", {
        goalPath: input.location.path,
        cause,
      }));
  const states = Stream.fromEffect(
    readGoalState({
      path: input.location.path,
      onMalformed,
      emitMissing: false,
    }),
  ).pipe(
    Stream.concat(
      input.ticks.pipe(
        Stream.catchCause(() => Stream.empty),
        Stream.mapEffect(() =>
          readGoalState({
            path: input.location.path,
            onMalformed,
            emitMissing: true,
          }),
        ),
      ),
    ),
  );
  return states.pipe(
    Stream.flatMap((result) =>
      result.kind === "emit" ? Stream.succeed(result.state) : Stream.empty,
    ),
    Stream.changesWith(sameGoalState),
    Stream.map((state) => state.goal),
  );
};

/**
 * Stop-time reconciliation for the session-scoped goal watch. The watch fiber
 * dies with the session scope, so a goal write that lands after the last
 * processed tick — the model marking the goal complete during final-turn
 * teardown, or a race with the reaper — would otherwise leave the projection
 * (and the goal pill) stuck at the previous value until the session restarts.
 * Reads the file once more and returns the goal state to project, `null` when
 * the goal was removed, or `undefined` when nothing changed / the file is
 * unreadable (a corrupt file must not erase the last honest projection).
 */
export const reconcileOmoGoalOnStop = (input: {
  readonly location: OmoGoalFileLocation;
  readonly lastProjected: ThreadGoalValue | null;
  readonly onMalformed?: (cause: unknown) => Effect.Effect<void>;
}): Effect.Effect<ThreadGoalValue | null | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const result = yield* readGoalState({
      path: input.location.path,
      onMalformed:
        input.onMalformed ??
        ((cause: unknown) =>
          Effect.logWarning("omo goal file is malformed", {
            goalPath: input.location.path,
            cause,
          })),
      emitMissing: true,
    });
    if (result.kind === "skip") {
      return undefined;
    }
    // Compare goals only: the file going missing between projections must not
    // manufacture a `null` event for a session that never had a goal.
    const lastState: OmoGoalFileState =
      input.lastProjected === null
        ? { source: "missing", goal: null }
        : { source: "file", goal: input.lastProjected };
    const unchanged = sameGoalState(lastState, result.state);
    return unchanged ? undefined : result.state.goal;
  });

export const watchOmoGoal = (input: {
  readonly sessionFile: string;
  readonly durableSessionId: string;
  readonly onMalformed?: (cause: unknown) => Effect.Effect<void>;
}): Stream.Stream<ThreadGoalValue | null, never, FileSystem.FileSystem> => {
  const location = resolveOmoGoalFile(input.sessionFile, input.durableSessionId);
  return Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(location.directory, { recursive: true }).pipe(Effect.ignore);
      return projectOmoGoalTicks({
        location,
        ticks: omoWatchTicks(fs.watch(location.directory)).pipe(Stream.drop(1)),
        ...(input.onMalformed === undefined ? {} : { onMalformed: input.onMalformed }),
      });
    }),
  );
};
