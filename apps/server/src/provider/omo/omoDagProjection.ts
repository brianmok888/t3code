import type { ThreadDagNodeActivity, ThreadDagRun, ThreadDagRunNode } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Wire mirrors of the omo dag bridge payload family
 * (omo `packages/omo-senpi/src/components/task/dag-snapshot-payload.ts` and
 * `dag-rpc-bridge-contract.ts`): `omo.dag.updated` wholesale snapshots and
 * `omo.dag.activity` latest-wins node telemetry. snake_case passthrough;
 * `state`/`status` stay opaque strings so upstream vocabulary drift degrades
 * to a skipped projection instead of a decode crash, mirroring
 * `decodeOmoTaskUpdatedSubagents` tolerance.
 */
const OmoDagNodeRecord = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  prompt: Schema.String,
  depends_on: Schema.Array(Schema.String),
  state: Schema.String,
  task_id: Schema.optional(Schema.String),
  attempt: Schema.Number,
  created_at: Schema.String,
  started_at: Schema.optional(Schema.String),
  completed_at: Schema.optional(Schema.String),
});

const OmoDagEdgeRecord = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
});

const OmoDagWaveRecord = Schema.Struct({
  index: Schema.Number,
  node_ids: Schema.Array(Schema.String),
});

const OmoDagRunRecord = Schema.Struct({
  run_id: Schema.String,
  run_key: Schema.String,
  name: Schema.String,
  status: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  counts: Schema.Record(Schema.String, Schema.Number),
  nodes: Schema.Array(OmoDagNodeRecord),
  edges: Schema.Array(OmoDagEdgeRecord),
  waves: Schema.Array(OmoDagWaveRecord),
});

const OmoDagUpdatedRecord = Schema.Struct({
  parent_session_id: Schema.String,
  runs: Schema.Array(OmoDagRunRecord),
  truncated_runs: Schema.optional(Schema.Number),
});

const OmoDagActivityRecord = Schema.Struct({
  run_id: Schema.String,
  node_id: Schema.String,
  activity: Schema.String,
  current_tool: Schema.optional(Schema.String),
  last_assistant_line: Schema.optional(Schema.String),
  turns: Schema.Number,
  tool_calls: Schema.optional(Schema.Number),
  at: Schema.String,
});

const decodeUpdated = Schema.decodeUnknownResult(OmoDagUpdatedRecord);
const decodeActivity = Schema.decodeUnknownResult(OmoDagActivityRecord);

const toThreadDagRunNode = (node: typeof OmoDagNodeRecord.Type): ThreadDagRunNode => ({
  id: node.id,
  ...(node.label === undefined ? {} : { label: node.label }),
  prompt: node.prompt,
  dependsOn: node.depends_on,
  state: node.state,
  ...(node.task_id === undefined ? {} : { taskId: node.task_id }),
  attempt: node.attempt,
  createdAt: node.created_at,
  ...(node.started_at === undefined ? {} : { startedAt: node.started_at }),
  ...(node.completed_at === undefined ? {} : { completedAt: node.completed_at }),
});

const toThreadDagRun = (run: typeof OmoDagRunRecord.Type): ThreadDagRun => ({
  runId: run.run_id,
  runKey: run.run_key,
  name: run.name,
  status: run.status,
  createdAt: run.created_at,
  updatedAt: run.updated_at,
  counts: run.counts,
  nodes: run.nodes.map(toThreadDagRunNode),
  edges: run.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  waves: run.waves.map((wave) => ({ index: wave.index, nodeIds: wave.node_ids })),
});

/** Decode an `omo.dag.updated` wholesale snapshot; malformed or cross-session input yields undefined. */
export const decodeOmoDagUpdatedRuns = (
  data: unknown,
  expectedParentSessionId: string,
): readonly ThreadDagRun[] | undefined => {
  const decoded = decodeUpdated(data);
  if (Result.isFailure(decoded) || decoded.success.parent_session_id !== expectedParentSessionId) {
    return undefined;
  }
  return decoded.success.runs.map(toThreadDagRun);
};

export interface OmoDagActivityUpdate {
  readonly runId: string;
  readonly nodeId: string;
  readonly activity: ThreadDagNodeActivity;
}

/** Decode an `omo.dag.activity` event; malformed input yields undefined. */
export const decodeOmoDagActivity = (data: unknown): OmoDagActivityUpdate | undefined => {
  const decoded = decodeActivity(data);
  if (Result.isFailure(decoded)) return undefined;
  const record = decoded.success;
  return {
    runId: record.run_id,
    nodeId: record.node_id,
    activity: {
      activity: record.activity,
      ...(record.current_tool === undefined ? {} : { currentTool: record.current_tool }),
      ...(record.last_assistant_line === undefined
        ? {}
        : { lastAssistantLine: record.last_assistant_line }),
      turns: record.turns,
      ...(record.tool_calls === undefined ? {} : { toolCalls: record.tool_calls }),
      at: record.at,
    },
  };
};

/**
 * Re-apply the latest-wins activity map onto a fresh snapshot so the panel
 * keeps per-node live telemetry between wholesale `omo.dag.updated` flushes.
 */
export const mergeOmoDagActivityIntoRuns = (
  runs: readonly ThreadDagRun[],
  activityByNode: ReadonlyMap<string, ThreadDagNodeActivity>,
): readonly ThreadDagRun[] =>
  runs.map((run) => ({
    ...run,
    nodes: run.nodes.map((node) => {
      const activity = activityByNode.get(`${run.runId}:${node.id}`);
      return activity === undefined ? node : { ...node, activity };
    }),
  }));
