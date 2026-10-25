import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Mirror of omo's builtin goal store record
 * (omo `core/extensions/builtin/goal/types.ts` `Goal`), projected per
 * thread. Timestamp fields are epoch SECONDS relayed as-is from the goal
 * file — clients compute live elapsed from `lastStartedAt`; the server never
 * ticks. `blockedReason` is present only while `status === "blocked"`.
 */
export const ThreadGoalStatus = Schema.Literals(["active", "paused", "blocked", "complete"]);
export type ThreadGoalStatus = typeof ThreadGoalStatus.Type;

export const ThreadGoal = Schema.Struct({
  id: TrimmedNonEmptyString,
  objective: TrimmedNonEmptyString,
  status: ThreadGoalStatus,
  blockedReason: Schema.optional(TrimmedNonEmptyString),
  tokensUsed: NonNegativeInt,
  timeUsedSeconds: NonNegativeInt,
  lastStartedAt: Schema.optional(NonNegativeInt),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
});
export type ThreadGoal = typeof ThreadGoal.Type;

/** omo-task `TASK_STATUSES` vocabulary (omo `omo-task/src/state/types.ts`). */
export const ThreadSubagentTaskStatus = Schema.Literals([
  "pending",
  "running",
  "completed",
  "error",
  "cancelled",
  "interrupted",
  "lost",
]);
export type ThreadSubagentTaskStatus = typeof ThreadSubagentTaskStatus.Type;

/** omo-task `RESIDENCY_STATES` vocabulary. */
export const ThreadSubagentTaskResidencyState = Schema.Literals([
  "resident",
  "evicted",
  "disposed",
  "persisted_only",
  "rpc_detached",
]);
export type ThreadSubagentTaskResidencyState = typeof ThreadSubagentTaskResidencyState.Type;

/**
 * Terminal-only run summary: omo-task attaches `run_stats` exclusively on
 * finish/fail/cancel/interrupt transitions, so a running record never
 * carries this field.
 */
export const ThreadSubagentRunStats = Schema.Struct({
  turns: NonNegativeInt,
  toolCalls: NonNegativeInt,
});
export type ThreadSubagentRunStats = typeof ThreadSubagentRunStats.Type;

export const ThreadSubagentLiveProgress = Schema.Struct({
  activity: Schema.optional(TrimmedNonEmptyString),
  statusLine: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadSubagentLiveProgress = typeof ThreadSubagentLiveProgress.Type;

export const ThreadSubagentUsage = Schema.Struct({
  totalTokens: NonNegativeInt,
  outputTokens: Schema.optional(NonNegativeInt),
  toolCalls: Schema.optional(NonNegativeInt),
  runtimeMs: Schema.optional(NonNegativeInt),
});
export type ThreadSubagentUsage = typeof ThreadSubagentUsage.Type;

/**
 * Mirror of a omo-task task record (`st_*.json`) projected onto the thread
 * whose durable session id matches the record's `parent_session_id`.
 * `executionMode` stays an open string — the vocabulary is owned by
 * omo-task, not by this contract.
 */
export const ThreadSubagentTask = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  taskSummary: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  agentType: Schema.optional(TrimmedNonEmptyString),
  category: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  status: ThreadSubagentTaskStatus,
  residencyState: ThreadSubagentTaskResidencyState,
  executionMode: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  runStats: Schema.optional(ThreadSubagentRunStats),
  childSessionId: Schema.optional(TrimmedNonEmptyString),
  liveProgress: Schema.optional(ThreadSubagentLiveProgress),
  currentTool: Schema.optional(TrimmedNonEmptyString),
  usage: Schema.optional(ThreadSubagentUsage),
  result: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadSubagentTask = typeof ThreadSubagentTask.Type;

/** Thread-scoped lookup for one omo-task child transcript. */
export const OmoSubagentTranscriptRequest = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type OmoSubagentTranscriptRequest = typeof OmoSubagentTranscriptRequest.Type;

export const OmoSubagentSendRequest = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type OmoSubagentSendRequest = typeof OmoSubagentSendRequest.Type;

export const OmoSubagentCancelRequest = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type OmoSubagentCancelRequest = typeof OmoSubagentCancelRequest.Type;

const OmoSubagentNotFoundResult = Schema.Struct({
  kind: Schema.Literal("not_found"),
  reason: TrimmedNonEmptyString,
});
const OmoSubagentUnavailableResult = Schema.Struct({
  kind: Schema.Literal("unavailable"),
  reason: TrimmedNonEmptyString,
});
const OmoSubagentInvalidArgumentsResult = Schema.Struct({
  kind: Schema.Literal("invalid_arguments"),
  reason: TrimmedNonEmptyString,
});

export const OmoSubagentSendResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("steered"),
    taskId: TrimmedNonEmptyString,
    status: Schema.Literals(["pending", "running"]),
    delivered: Schema.Literal("steer"),
  }),
  OmoSubagentNotFoundResult,
  OmoSubagentUnavailableResult,
  OmoSubagentInvalidArgumentsResult,
]);
export type OmoSubagentSendResult = typeof OmoSubagentSendResult.Type;

export const OmoSubagentCancelResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cancelled"),
    taskId: TrimmedNonEmptyString,
    previousStatus: ThreadSubagentTaskStatus,
  }),
  OmoSubagentNotFoundResult,
  OmoSubagentUnavailableResult,
  OmoSubagentInvalidArgumentsResult,
]);
export type OmoSubagentCancelResult = typeof OmoSubagentCancelResult.Type;

export const OmoSubagentOutputSnapshot = Schema.Struct({
  status: ThreadSubagentTaskStatus,
  finalResponse: Schema.optional(TrimmedNonEmptyString),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
});
export type OmoSubagentOutputSnapshot = typeof OmoSubagentOutputSnapshot.Type;

export const OmoSubagentOutputResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("transcript"),
    transcript: Schema.String,
    truncated: Schema.Boolean,
    snapshot: OmoSubagentOutputSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("status"),
    snapshot: OmoSubagentOutputSnapshot,
  }),
  OmoSubagentNotFoundResult,
  OmoSubagentUnavailableResult,
  OmoSubagentInvalidArgumentsResult,
]);
export type OmoSubagentOutputResult = typeof OmoSubagentOutputResult.Type;

export class OmoSubagentControlError extends Schema.TaggedError<OmoSubagentControlError>()(
  "OmoSubagentControlError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export const OmoSubagentTranscriptEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("transition_applied"),
    status: ThreadSubagentTaskStatus,
    residencyState: ThreadSubagentTaskResidencyState,
  }),
  Schema.Struct({ type: Schema.Literal("assistant_message"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_execution"),
    tool: Schema.String,
    isError: Schema.Boolean,
  }),
  // Lifecycle markers carry no payload: omo logs a suspend `reason` and a
  // reattach `session_path`, but both are server-local facts and the client
  // renders fixed copy for each.
  Schema.Struct({ type: Schema.Literal("suspended") }),
  Schema.Struct({ type: Schema.Literal("reconcile_reattached") }),
  Schema.Struct({
    type: Schema.Literal("unknown"),
    originalType: Schema.String,
    payload: Schema.Unknown,
  }),
]);
export type OmoSubagentTranscriptEvent = typeof OmoSubagentTranscriptEvent.Type;

/** Bounded transcript shape returned by the omo artifact reader. */
export const OmoSubagentTranscript = Schema.Struct({
  events: Schema.Array(OmoSubagentTranscriptEvent),
  truncated: Schema.Boolean,
});
export type OmoSubagentTranscript = typeof OmoSubagentTranscript.Type;

/** Transcript and completion artifact returned in one pane-ready response. */
export const OmoSubagentTranscriptPayload = Schema.Struct({
  transcript: OmoSubagentTranscript,
  result: Schema.NullOr(Schema.String),
});
export type OmoSubagentTranscriptPayload = typeof OmoSubagentTranscriptPayload.Type;

export class OmoSubagentTranscriptError extends Schema.TaggedError<OmoSubagentTranscriptError>()(
  "OmoSubagentTranscriptError",
  {
    reason: Schema.Literals([
      "thread_not_found",
      "project_not_found",
      "task_not_found",
      "invalid_task_id",
      "read_failed",
    ]),
    detail: Schema.String,
  },
) {}

export const THREAD_STEERING_QUEUED_MESSAGE_MODES = ["steer", "followUp"] as const;
export const ThreadSteeringQueuedMessageMode = Schema.Literals(
  THREAD_STEERING_QUEUED_MESSAGE_MODES,
);
export type ThreadSteeringQueuedMessageMode = typeof ThreadSteeringQueuedMessageMode.Type;

/** Client-selected delivery semantics for a thread send. */
export const ThreadTurnDeliveryMode = Schema.Literals([
  "normal",
  ...THREAD_STEERING_QUEUED_MESSAGE_MODES,
]);
export type ThreadTurnDeliveryMode = typeof ThreadTurnDeliveryMode.Type;

export const ThreadSteeringQueuedMessage = Schema.Struct({
  text: Schema.String,
  mode: ThreadSteeringQueuedMessageMode,
});
export type ThreadSteeringQueuedMessage = typeof ThreadSteeringQueuedMessage.Type;

/**
 * omo busy truth for a thread: `isStreaming`/`pendingMessageCount` come
 * from omo's session state (never inferred from T3's own turn model) and
 * `queued` lists the steering/followUp messages known to be waiting.
 */
export const ThreadSteeringState = Schema.Struct({
  isStreaming: Schema.Boolean,
  pendingMessageCount: NonNegativeInt,
  queued: Schema.Array(ThreadSteeringQueuedMessage).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ThreadSteeringState = typeof ThreadSteeringState.Type;

/**
 * A omo background monitor surfaced on the thread.
 *
 * `paused` is reported ONLY by omo's authoritative `terminal_monitor_state`
 * snapshot (wake-budget pause). It is never inferred from tool results, so a
 * binary that does not emit that event yields only `active | ended`.
 */
export const ThreadActiveMonitorStatus = Schema.Literals(["active", "paused", "ended"]);
export type ThreadActiveMonitorStatus = typeof ThreadActiveMonitorStatus.Type;

export const ThreadActiveMonitor = Schema.Struct({
  bashId: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  startedAtMs: NonNegativeInt,
  status: ThreadActiveMonitorStatus,
});
export type ThreadActiveMonitor = typeof ThreadActiveMonitor.Type;

/**
 * Mirror of one active omo start-work record projected from `.omo/boulder.json`.
 * The status is closed to `active` because completed and otherwise inactive
 * records are removed by the server projection before reaching this contract.
 */
export const ThreadActiveWork = Schema.Struct({
  workId: TrimmedNonEmptyString,
  planName: TrimmedNonEmptyString,
  status: Schema.Literal("active"),
  worktreePath: Schema.optional(TrimmedNonEmptyString),
  sessionIds: Schema.Array(TrimmedNonEmptyString),
});
export type ThreadActiveWork = typeof ThreadActiveWork.Type;

/** Exact wire mirror of `OmoWorkActivitySummary`. */
export const ThreadWorkActivitySummary = Schema.Struct({
  activeWorks: Schema.Array(ThreadActiveWork),
});
export type ThreadWorkActivitySummary = typeof ThreadWorkActivitySummary.Type;

export const ThreadGoalUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  /** Null means the goal was removed (omo writes `{version:1, goal:null}`). */
  goal: Schema.NullOr(ThreadGoal),
  updatedAt: IsoDateTime,
});
export type ThreadGoalUpdatedPayload = typeof ThreadGoalUpdatedPayload.Type;

export const ThreadSubagentsUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  subagents: Schema.Array(ThreadSubagentTask),
  updatedAt: IsoDateTime,
});
export type ThreadSubagentsUpdatedPayload = typeof ThreadSubagentsUpdatedPayload.Type;

/** Live activity snapshot for a running DAG node (omo mass-ulw projection). */
export const ThreadDagNodeActivity = Schema.Struct({
  activity: Schema.String,
  currentTool: Schema.optional(Schema.String),
  lastAssistantLine: Schema.optional(Schema.String),
  turns: Schema.Number,
  toolCalls: Schema.optional(Schema.Number),
  at: Schema.String,
});
export type ThreadDagNodeActivity = typeof ThreadDagNodeActivity.Type;

/**
 * One node of an omo mass-ulw DAG run. `state` stays an open string — the
 * vocabulary is owned by the DAG runner, not by this contract.
 */
export const ThreadDagRunNode = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  prompt: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  state: Schema.String,
  taskId: Schema.optional(Schema.String),
  attempt: Schema.Number,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  activity: Schema.optional(ThreadDagNodeActivity),
});
export type ThreadDagRunNode = typeof ThreadDagRunNode.Type;

export const ThreadDagRunEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});
export type ThreadDagRunEdge = typeof ThreadDagRunEdge.Type;

/** A topological execution wave: nodes that may run in parallel. */
export const ThreadDagRunWave = Schema.Struct({
  index: Schema.Number,
  nodeIds: Schema.Array(Schema.String),
});
export type ThreadDagRunWave = typeof ThreadDagRunWave.Type;

/**
 * Mirror of an omo mass-ulw DAG run surfaced in the thread panel. `status`,
 * `state` and timestamps stay open strings — tolerant passthrough while the
 * upstream vocabulary drifts.
 */
export const ThreadDagRun = Schema.Struct({
  runId: Schema.String,
  runKey: Schema.String,
  name: Schema.String,
  status: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  counts: Schema.Record(Schema.String, Schema.Number),
  nodes: Schema.Array(ThreadDagRunNode),
  edges: Schema.Array(ThreadDagRunEdge),
  waves: Schema.Array(ThreadDagRunWave),
});
export type ThreadDagRun = typeof ThreadDagRun.Type;

export const ThreadDagRunsUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  dagRuns: Schema.Array(ThreadDagRun),
  updatedAt: IsoDateTime,
});
export type ThreadDagRunsUpdatedPayload = typeof ThreadDagRunsUpdatedPayload.Type;

/**
 * Partial runtime-projection update: each producer (steering send path,
 * monitor lifecycle, stats/compaction relay) sets only its own slice, so
 * every field is optional and absent means "unchanged", never "cleared".
 * `sessionStats` is a passthrough of omo's `get_session_stats` payload.
 */
export const ThreadRuntimeUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  steering: Schema.optional(ThreadSteeringState),
  activeMonitors: Schema.optional(Schema.Array(ThreadActiveMonitor)),
  activeWorks: Schema.optional(Schema.Array(ThreadActiveWork)),
  ulwActive: Schema.optional(Schema.Boolean),
  autoCompactionEnabled: Schema.optional(Schema.Boolean),
  sessionStats: Schema.optional(Schema.Unknown),
  updatedAt: IsoDateTime,
});
export type ThreadRuntimeUpdatedPayload = typeof ThreadRuntimeUpdatedPayload.Type;
