import type { ThreadSteeringState, ThreadTurnDeliveryMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OmoCommand } from "../omo/omoRpcProtocol.ts";
import type { OmoSuccessfulResponse } from "./OmoSessionHandle.ts";

export const OMO_ALREADY_PROCESSING_PREFIX = "Agent is already processing";

type OmoPromptCommand = Extract<OmoCommand, { readonly type: "prompt" }>;

type DetailError = { readonly detail: string };

const hasDetail = (error: unknown): error is DetailError =>
  typeof error === "object" &&
  error !== null &&
  "detail" in error &&
  typeof error.detail === "string";

export const isOmoAlreadyProcessingError = (error: unknown): boolean =>
  hasDetail(error) && error.detail.startsWith(OMO_ALREADY_PROCESSING_PREFIX);

export const resolveOmoDeliveryMode = (
  requested: ThreadTurnDeliveryMode | undefined,
  isStreaming: boolean,
): ThreadTurnDeliveryMode => {
  const mode = requested ?? "normal";
  return mode === "normal" && isStreaming ? "steer" : mode;
};

/**
 * senpi rejects a prompt that carries `thinkingLevel` alongside
 * `streamingBehavior`, both while streaming (connection-handler.ts:673-680)
 * and on the idle queue path (agent-session.ts:2765-2768). Dropping it here is
 * loss-free: OmoAdapter already applies a changed level session-side with
 * `set_thinking_level` scope "turn" before the prompt, and an unchanged level
 * is already active on the session.
 */
const withDeliveryMode = (
  command: OmoPromptCommand,
  mode: ThreadTurnDeliveryMode,
): OmoPromptCommand => {
  if (mode === "normal") return command;
  const { thinkingLevel: _thinkingLevel, ...queueable } = command;
  return {
    ...queueable,
    streamingBehavior: mode,
  };
};

export const sendOmoPromptSteerAware = <E>(input: {
  readonly command: OmoPromptCommand;
  readonly deliveryMode: ThreadTurnDeliveryMode | undefined;
  readonly isStreaming: boolean;
  readonly send: (command: OmoPromptCommand) => Effect.Effect<OmoSuccessfulResponse, E>;
}): Effect.Effect<
  {
    readonly response: OmoSuccessfulResponse;
    readonly deliveryMode: ThreadTurnDeliveryMode;
    readonly retriedAsSteer: boolean;
  },
  E
> => {
  const deliveryMode = resolveOmoDeliveryMode(input.deliveryMode, input.isStreaming);
  const initialCommand = withDeliveryMode(input.command, deliveryMode);
  return input.send(initialCommand).pipe(
    Effect.map((response) => ({ response, deliveryMode, retriedAsSteer: false })),
    Effect.catch((error) => {
      if (deliveryMode !== "normal" || !isOmoAlreadyProcessingError(error)) {
        return Effect.fail(error);
      }
      return input.send(withDeliveryMode(input.command, "steer")).pipe(
        Effect.map((response) => ({
          response,
          deliveryMode: "steer" as const,
          retriedAsSteer: true,
        })),
      );
    }),
  );
};

export const projectOmoSteeringState = (state: ThreadSteeringState): ThreadSteeringState => ({
  isStreaming: state.isStreaming,
  pendingMessageCount: state.pendingMessageCount,
  queued: state.queued.map((entry) => ({ ...entry })),
});
