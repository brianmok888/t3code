// Port reconstruction (omo fork): omo-desktop's Services/ProviderAdapter.ts
// did not survive the bundle extraction. This shape is derived from the
// ported OmoAdapter implementations (the annotated `OmoAdapterShape[...]`
// members are the source of truth); returns are deliberately wide where the
// driver boundary does not depend on them.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  type ModelSelection,
  type ProviderSendTurnInput,
  ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  type TurnId,
  type RuntimeMode,
} from "@t3tools/contracts";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderRuntimeEvent } from "../omo/omoRuntimeEvents.ts";

export interface ProviderAdapterCapabilities {
  readonly sessionModelSwitch: "in-session" | "restart-required" | "unsupported";
}

export interface ProviderSubagentTaskMessageInput {
  readonly taskId: string;
  readonly message: string;
}

export interface ProviderSubagentTaskCancelInput {
  readonly taskId: string;
  readonly reason?: string | undefined;
}

export interface ProviderSubagentTaskReadInput {
  readonly taskId: string;
}

export interface ProviderAdapterStartSessionInput {
  readonly runtimeMode?: RuntimeMode;
  readonly threadId: ThreadId;
  readonly provider?: typeof ProviderDriverKind.Type;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly modelSelection?: ModelSelection;
  readonly resumeCursor?: unknown;
}

export type ProviderSetSessionModel<E = ProviderAdapterError> = (
  threadId: ThreadId,
  model: string,
) => Effect.Effect<string, E>;

export interface ProviderAdapterShape<E = ProviderAdapterError> {
  readonly provider: typeof ProviderDriverKind.Type;
  readonly instanceId?: ProviderInstanceId;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly startSession: (input: ProviderAdapterStartSessionInput) => Effect.Effect<unknown, E>;
  readonly sendTurn: (input: ProviderSendTurnInput) => Effect.Effect<unknown, E>;
  readonly setSessionModel?: (threadId: ThreadId, model: string) => Effect.Effect<string, E>;
  readonly interruptTurn: (threadId: ThreadId, turnId: TurnId) => Effect.Effect<void, E>;
  readonly respondToRequest: () => Effect.Effect<void, E>;
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: string,
    answers: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<void, E>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, E>;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<{ readonly threadId: string }>, E>;
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean, E>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<unknown, E>;
  readonly rollbackThread: () => Effect.Effect<void, E>;
  readonly stopAll: () => Effect.Effect<void, E>;
  readonly sendSubagentMessage?: (
    threadId: ThreadId,
    input: ProviderSubagentTaskMessageInput,
  ) => Effect.Effect<unknown, E>;
  readonly cancelSubagentTask?: (
    threadId: ThreadId,
    input: ProviderSubagentTaskCancelInput,
  ) => Effect.Effect<unknown, E>;
  readonly readSubagentOutput?: (
    threadId: ThreadId,
    input: ProviderSubagentTaskReadInput,
  ) => Effect.Effect<unknown, E>;
}

export class ProviderAdapter extends Context.Service<
  ProviderAdapter,
  { readonly make: (input: unknown) => Effect.Effect<ProviderAdapterShape> }
>()("omo/provider/Services/ProviderAdapter") {}
