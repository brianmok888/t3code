import {
  ThreadSubagentTaskStatus,
  type OmoSubagentCancelRequest,
  type OmoSubagentCancelResult,
  type OmoSubagentOutputResult,
  type OmoSubagentOutputSnapshot,
  type OmoSubagentSendRequest,
  type OmoSubagentSendResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OmoSessionHandleProtocolError, type OmoSessionHandle } from "./OmoSessionHandle.ts";
import type { OmoModelRef } from "../omo/omoMappers.ts";
import type { OmoSharedProcessError } from "../omo/omoRpcConnection.ts";
import { OmoSetModelData, type OmoSessionStatsData } from "../omo/omoRpcProtocol.ts";
import {
  getOmoSessionStats,
  runOmoCompaction,
  setOmoAutoCompaction,
  type OmoCompactionOutcome,
  type OmoSessionNotification,
} from "../omo/omoSessionStats.ts";

const decodeSetModelData = Schema.decodeUnknownEffect(OmoSetModelData);

const OmoTaskSendData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("steered"),
    task_id: Schema.String,
    status: Schema.Literals(["pending", "running"]),
    delivered: Schema.Literal("steer"),
  }),
  Schema.Struct({ kind: Schema.Literal("not_found"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("scope_denied"),
    task_id: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("invalid_arguments"), reason: Schema.String }),
]);
const OmoTaskCancelData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cancelled"),
    task_id: Schema.String,
    previous_status: ThreadSubagentTaskStatus,
  }),
  Schema.Struct({ kind: Schema.Literal("not_found"), reason: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("scope_denied"),
    task_id: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("invalid_arguments"), reason: Schema.String }),
]);
const OmoTaskOutputSnapshotData = Schema.Struct({
  status: ThreadSubagentTaskStatus,
  final_response: Schema.optional(Schema.String),
  error_message: Schema.optional(Schema.String),
});
const OmoTaskOutputData = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("transcript"),
    transcript: Schema.String,
    truncated: Schema.Boolean,
    snapshot: OmoTaskOutputSnapshotData,
  }),
  Schema.Struct({
    kind: Schema.Literal("status"),
    snapshot: OmoTaskOutputSnapshotData,
  }),
  Schema.Struct({ kind: Schema.Literal("not_found"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("invalid_arguments"), reason: Schema.String }),
]);

const decodeTaskSendData = Schema.decodeUnknownEffect(OmoTaskSendData);
const decodeTaskCancelData = Schema.decodeUnknownEffect(OmoTaskCancelData);
const decodeTaskOutputData = Schema.decodeUnknownEffect(OmoTaskOutputData);

type OmoSessionCommandError = OmoSharedProcessError | OmoSessionHandleProtocolError;

export const sendSetModel = (
  handle: OmoSessionHandle,
  ref: OmoModelRef,
): Effect.Effect<OmoModelRef, OmoSharedProcessError | OmoSessionHandleProtocolError> =>
  handle.send({ type: "set_model", provider: ref.provider, modelId: ref.modelId }).pipe(
    Effect.flatMap((response) =>
      decodeSetModelData(response.data).pipe(
        Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
        Effect.map((model): OmoModelRef => ({
          provider: model.provider,
          modelId: model.id,
        })),
      ),
    ),
  );

/** `omo.stats.get` — one on-demand `get_session_stats`, never polled. */
export const sendGetSessionStats = (
  handle: OmoSessionHandle,
): Effect.Effect<OmoSessionStatsData, OmoSessionCommandError> =>
  getOmoSessionStats({ send: handle.send });

/** `omo.compact.run` — compacts and notifies on both terminal paths. */
export const sendCompact = (
  handle: OmoSessionHandle,
  input: {
    readonly customInstructions?: string;
    readonly notify: (notification: OmoSessionNotification) => Effect.Effect<void>;
  },
): Effect.Effect<OmoCompactionOutcome, OmoSessionCommandError> =>
  runOmoCompaction({ send: handle.send, ...input });

/** `omo.autoCompaction.set` — answers with the value the get_state refresh reports. */
export const sendSetAutoCompaction = (
  handle: OmoSessionHandle,
  enabled: boolean,
): Effect.Effect<boolean, OmoSessionCommandError> =>
  setOmoAutoCompaction({ send: handle.send, enabled });

export const sendOmoTaskMessage = (
  handle: OmoSessionHandle,
  input: Omit<OmoSubagentSendRequest, "threadId">,
): Effect.Effect<OmoSubagentSendResult, OmoSessionCommandError> =>
  handle
    .send({
      type: "extension_request",
      name: "omo.task.send",
      data: { to: input.taskId, message: input.message },
    })
    .pipe(
      Effect.flatMap((response) =>
        decodeTaskSendData(response.data).pipe(
          Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
        ),
      ),
      Effect.map((result): OmoSubagentSendResult => {
        switch (result.kind) {
          case "steered":
            return {
              kind: "steered",
              taskId: result.task_id,
              status: result.status,
              delivered: result.delivered,
            };
          case "scope_denied":
          case "not_found":
            return { kind: "not_found", reason: "Task not found." };
          case "unavailable":
          case "invalid_arguments":
            return result;
        }
      }),
    );

export const sendOmoTaskCancel = (
  handle: OmoSessionHandle,
  input: Omit<OmoSubagentCancelRequest, "threadId">,
): Effect.Effect<OmoSubagentCancelResult, OmoSessionCommandError> =>
  handle
    .send({
      type: "extension_request",
      name: "omo.task.cancel",
      data: {
        task_id: input.taskId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
    })
    .pipe(
      Effect.flatMap((response) =>
        decodeTaskCancelData(response.data).pipe(
          Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
        ),
      ),
      Effect.map((result): OmoSubagentCancelResult => {
        switch (result.kind) {
          case "cancelled":
            return {
              kind: "cancelled",
              taskId: result.task_id,
              previousStatus: result.previous_status,
            };
          case "scope_denied":
          case "not_found":
            return { kind: "not_found", reason: "Task not found." };
          case "unavailable":
          case "invalid_arguments":
            return result;
        }
      }),
    );

export const sendOmoTaskOutput = (
  handle: OmoSessionHandle,
  input: { readonly taskId: string },
): Effect.Effect<OmoSubagentOutputResult, OmoSessionCommandError> =>
  handle
    .send({
      type: "extension_request",
      name: "omo.task.output",
      data: { task_id: input.taskId, mode: "tail", tail_lines: 1_000 },
    })
    .pipe(
      Effect.flatMap((response) =>
        decodeTaskOutputData(response.data).pipe(
          Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
        ),
      ),
      Effect.map((result): OmoSubagentOutputResult => {
        switch (result.kind) {
          case "transcript":
            return {
              kind: "transcript",
              transcript: result.transcript,
              truncated: result.truncated,
              snapshot: taskOutputSnapshot(result.snapshot),
            };
          case "status":
            return { kind: "status", snapshot: taskOutputSnapshot(result.snapshot) };
          case "not_found":
          case "unavailable":
          case "invalid_arguments":
            return result;
        }
      }),
    );

const taskOutputSnapshot = (
  snapshot: typeof OmoTaskOutputSnapshotData.Type,
): OmoSubagentOutputSnapshot => ({
  status: snapshot.status,
  ...(snapshot.final_response === undefined ? {} : { finalResponse: snapshot.final_response }),
  ...(snapshot.error_message === undefined ? {} : { errorMessage: snapshot.error_message }),
});
