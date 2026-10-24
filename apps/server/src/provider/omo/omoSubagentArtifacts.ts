import { ThreadSubagentTaskResidencyState, ThreadSubagentTaskStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const TASK_ID_PATTERN = /^st_[0-9a-f]+$/;
const TRANSCRIPT_EVENT_LIMIT = 2_000;

const TranscriptTransition = Schema.Struct({
  type: Schema.Literal("transition_applied"),
  payload: Schema.Struct({
    status: ThreadSubagentTaskStatus,
    residency_state: ThreadSubagentTaskResidencyState,
  }),
});

const TranscriptAssistantMessage = Schema.Struct({
  type: Schema.Literal("assistant_message"),
  payload: Schema.Struct({ text: Schema.String }),
});

const TranscriptToolExecution = Schema.Struct({
  type: Schema.Literal("tool_execution"),
  payload: Schema.Struct({ tool: Schema.String, is_error: Schema.Boolean }),
});

// Lifecycle envelopes: payloads (suspend `reason`, reattach `session_path`) are
// server-local detail; the contract event carries the marker alone.
const TranscriptSuspended = Schema.Struct({
  type: Schema.Literal("suspended"),
  payload: Schema.optional(Schema.Unknown),
});

const TranscriptReconcileReattached = Schema.Struct({
  type: Schema.Literal("reconcile_reattached"),
  payload: Schema.optional(Schema.Unknown),
});

const TranscriptUnknownEnvelope = Schema.Struct({
  type: Schema.String,
  payload: Schema.optional(Schema.Unknown),
});

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const isTransition = Schema.is(TranscriptTransition);
const isAssistantMessage = Schema.is(TranscriptAssistantMessage);
const isToolExecution = Schema.is(TranscriptToolExecution);
const isSuspended = Schema.is(TranscriptSuspended);
const isReconcileReattached = Schema.is(TranscriptReconcileReattached);
const isUnknownEnvelope = Schema.is(TranscriptUnknownEnvelope);

export type OmoSubagentTranscriptEvent =
  | {
      readonly type: "transition_applied";
      readonly status: ThreadSubagentTaskStatus;
      readonly residencyState: ThreadSubagentTaskResidencyState;
    }
  | { readonly type: "assistant_message"; readonly text: string }
  | { readonly type: "tool_execution"; readonly tool: string; readonly isError: boolean }
  | { readonly type: "suspended" }
  | { readonly type: "reconcile_reattached" }
  | { readonly type: "unknown"; readonly originalType: string; readonly payload: unknown };

export type OmoSubagentTranscript = {
  readonly events: ReadonlyArray<OmoSubagentTranscriptEvent>;
  readonly truncated: boolean;
};

export class OmoSubagentTaskIdError extends Schema.TaggedErrorClass<OmoSubagentTaskIdError>()(
  "OmoSubagentTaskIdError",
  { taskId: Schema.String },
) {}

const stateDir = (path: Path.Path, projectDir: string): string =>
  path.join(projectDir, ".omo", "senpi-task");

const validTaskId = (taskId: string): Effect.Effect<string, OmoSubagentTaskIdError, never> =>
  TASK_ID_PATTERN.test(taskId)
    ? Effect.succeed(taskId)
    : Effect.fail(new OmoSubagentTaskIdError({ taskId }));

const transcriptEvent = (value: unknown): OmoSubagentTranscriptEvent => {
  if (isTransition(value)) {
    return {
      type: "transition_applied",
      status: value.payload.status,
      residencyState: value.payload.residency_state,
    };
  }
  if (isAssistantMessage(value)) {
    return { type: "assistant_message", text: value.payload.text };
  }
  if (isToolExecution(value)) {
    return {
      type: "tool_execution",
      tool: value.payload.tool,
      isError: value.payload.is_error,
    };
  }
  if (isSuspended(value)) return { type: "suspended" };
  if (isReconcileReattached(value)) return { type: "reconcile_reattached" };
  return isUnknownEnvelope(value)
    ? { type: "unknown", originalType: value.type, payload: value.payload }
    : { type: "unknown", originalType: "unknown", payload: value };
};

export const readOmoSubagentTranscript = (
  projectDir: string,
  taskId: string,
): Effect.Effect<
  OmoSubagentTranscript,
  OmoSubagentTaskIdError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const safeTaskId = yield* validTaskId(taskId);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem
      .readFileString(path.join(stateDir(path, projectDir), "logs", `${safeTaskId}.jsonl`))
      .pipe(Effect.option);
    if (Option.isNone(raw)) return { events: [], truncated: false };
    const events = raw.value
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const decoded = decodeJson(line);
        return Result.isFailure(decoded) ? [] : [transcriptEvent(decoded.success)];
      });
    return {
      events: events.slice(-TRANSCRIPT_EVENT_LIMIT),
      truncated: events.length > TRANSCRIPT_EVENT_LIMIT,
    };
  });

export const readOmoSubagentResult = (
  projectDir: string,
  taskId: string,
): Effect.Effect<string | null, OmoSubagentTaskIdError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const safeTaskId = yield* validTaskId(taskId);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const raw = yield* fileSystem
      .readFileString(
        path.join(stateDir(path, projectDir), "completion-results", `${safeTaskId}.txt`),
      )
      .pipe(Effect.option);
    return Option.getOrNull(raw);
  });
