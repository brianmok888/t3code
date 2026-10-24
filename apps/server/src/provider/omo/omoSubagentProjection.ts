import {
  IsoDateTime,
  NonNegativeInt,
  ThreadSubagentTaskResidencyState,
  ThreadSubagentTaskStatus,
  type ThreadId,
  type ThreadSubagentTask,
  type ThreadSubagentsUpdatedPayload,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const TASK_FILE_PATTERN = /^st_[0-9a-f]+\.json$/;

const OmoTaskRunStats = Schema.Struct({
  runtime_ms: Schema.optional(NonNegativeInt),
  turns: NonNegativeInt,
  tool_calls: NonNegativeInt,
  output_tokens: Schema.optional(NonNegativeInt),
  total_tokens: Schema.optional(NonNegativeInt),
});

const OmoTaskLiveProgress = Schema.Struct({
  activity: Schema.optional(Schema.String),
  status_line: Schema.optional(Schema.String),
  current_tool: Schema.optional(Schema.String),
  turns: Schema.optional(NonNegativeInt),
  tool_calls: Schema.optional(NonNegativeInt),
  total_tokens: Schema.optional(NonNegativeInt),
  output_tokens: Schema.optional(NonNegativeInt),
});

const OmoTaskFields = {
  task_id: Schema.String,
  name: Schema.optional(Schema.String),
  task_summary: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  depth: NonNegativeInt,
  agent_type: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  execution_mode: Schema.String,
  model: Schema.String,
  status: ThreadSubagentTaskStatus,
  residency_state: ThreadSubagentTaskResidencyState,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  run_stats: Schema.optional(OmoTaskRunStats),
  child_session_id: Schema.optional(Schema.String),
  live_progress: Schema.optional(OmoTaskLiveProgress),
  final_response: Schema.optional(Schema.String),
  error_message: Schema.optional(Schema.String),
} as const;

const OmoTaskRecord = Schema.Struct({
  ...OmoTaskFields,
  parent_session_id: Schema.String,
});

const OmoRpcTaskRecord = Schema.Struct(OmoTaskFields);
const OmoTaskUpdatedData = Schema.Struct({
  parent_session_id: Schema.String,
  tasks: Schema.Array(OmoRpcTaskRecord),
});

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeTaskRecord = Schema.decodeUnknownResult(OmoTaskRecord);
const decodeTaskUpdatedData = Schema.decodeUnknownResult(OmoTaskUpdatedData);

export type OmoSubagentSession = {
  readonly threadId: ThreadId;
  readonly durableSessionId: string;
};

export type OmoSubagentProjection = ThreadSubagentsUpdatedPayload;

const stateDir = (path: Path.Path, projectDir: string): string =>
  path.join(projectDir, ".omo", "senpi-task");

const isTerminalStatus = (status: ThreadSubagentTask["status"]): boolean =>
  status === "completed" ||
  status === "error" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "lost";

const toThreadSubagentTask = (record: typeof OmoRpcTaskRecord.Type): ThreadSubagentTask => {
  const totalTokens = record.live_progress?.total_tokens ?? record.run_stats?.total_tokens;
  return {
    taskId: record.task_id,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.task_summary === undefined ? {} : { taskSummary: record.task_summary }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.agent_type === undefined ? {} : { agentType: record.agent_type }),
    ...(record.category === undefined ? {} : { category: record.category }),
    model: record.model,
    status: record.status,
    residencyState: record.residency_state,
    executionMode: record.execution_mode,
    depth: record.depth,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    ...(record.run_stats === undefined || !isTerminalStatus(record.status)
      ? {}
      : {
          runStats: {
            turns: record.run_stats.turns,
            toolCalls: record.run_stats.tool_calls,
          },
        }),
    ...(record.child_session_id === undefined ? {} : { childSessionId: record.child_session_id }),
    ...(record.live_progress?.activity === undefined &&
    record.live_progress?.status_line === undefined
      ? {}
      : {
          liveProgress: {
            ...(record.live_progress.activity === undefined
              ? {}
              : { activity: record.live_progress.activity }),
            ...(record.live_progress.status_line === undefined
              ? {}
              : { statusLine: record.live_progress.status_line }),
          },
        }),
    ...(record.live_progress?.current_tool === undefined
      ? {}
      : { currentTool: record.live_progress.current_tool }),
    ...(totalTokens === undefined
      ? {}
      : {
          usage: {
            totalTokens,
            ...((record.live_progress?.output_tokens ?? record.run_stats?.output_tokens) ===
            undefined
              ? {}
              : {
                  outputTokens:
                    record.live_progress?.output_tokens ?? record.run_stats?.output_tokens,
                }),
            ...((record.live_progress?.tool_calls ?? record.run_stats?.tool_calls) === undefined
              ? {}
              : {
                  toolCalls: record.live_progress?.tool_calls ?? record.run_stats?.tool_calls,
                }),
            ...(record.run_stats?.runtime_ms === undefined
              ? {}
              : { runtimeMs: record.run_stats.runtime_ms }),
          },
        }),
    ...(record.status === "completed" && record.final_response !== undefined
      ? { result: record.final_response }
      : {}),
    ...((record.status === "error" || record.status === "lost") &&
    record.error_message !== undefined
      ? { error: record.error_message }
      : {}),
  };
};

export const decodeOmoTaskUpdatedSubagents = (
  value: unknown,
  expectedParentSessionId: string,
): ReadonlyArray<ThreadSubagentTask> | undefined => {
  const decoded = decodeTaskUpdatedData(value);
  if (Result.isFailure(decoded) || decoded.success.parent_session_id !== expectedParentSessionId) {
    return undefined;
  }
  return decoded.success.tasks.map(toThreadSubagentTask);
};

const readTaskRecords = (
  projectDir: string,
): Effect.Effect<
  ReadonlyArray<typeof OmoTaskRecord.Type>,
  never,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tasksDir = path.join(stateDir(path, projectDir), "tasks");
    const entries = yield* fileSystem
      .readDirectory(tasksDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const records = yield* Effect.forEach(
      entries.filter((entry) => TASK_FILE_PATTERN.test(entry)),
      (entry) =>
        fileSystem.readFileString(path.join(tasksDir, entry)).pipe(
          Effect.option,
          Effect.map(
            Option.flatMap((raw) => {
              const json = decodeJson(raw);
              if (Result.isFailure(json)) return Option.none();
              const decoded = decodeTaskRecord(json.success);
              return Result.isFailure(decoded) ? Option.none() : Option.some(decoded.success);
            }),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return records
      .filter(Option.isSome)
      .map(({ value }) => value)
      .sort((left, right) => left.task_id.localeCompare(right.task_id));
  });

export const readOmoSubagents = (
  projectDir: string,
  sessions: ReadonlyArray<OmoSubagentSession>,
): Effect.Effect<ReadonlyArray<OmoSubagentProjection>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const records = yield* readTaskRecords(projectDir);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    return sessions.map(({ threadId, durableSessionId }) => ({
      threadId,
      subagents: records
        .filter(({ parent_session_id }) => parent_session_id === durableSessionId)
        .map(toThreadSubagentTask),
      updatedAt,
    }));
  });

export const watchOmoSubagents = (
  projectDir: string,
  sessions: ReadonlyArray<OmoSubagentSession>,
): Stream.Stream<OmoSubagentProjection, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tasksDir = path.join(stateDir(path, projectDir), "tasks");
      yield* fileSystem.makeDirectory(tasksDir, { recursive: true }).pipe(Effect.ignore);
      const projections = () =>
        Stream.fromEffect(readOmoSubagents(projectDir, sessions)).pipe(Stream.flattenIterable);
      return Stream.merge(
        projections(),
        fileSystem.watch(tasksDir).pipe(
          Stream.debounce(Duration.millis(100)),
          Stream.flatMap(projections),
          Stream.catchCause(() => Stream.empty),
        ),
      );
    }),
  );
