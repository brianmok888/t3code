// Port reconstruction (omo fork): omo-desktop's Services/ProviderAdapter.ts
// did not survive the bundle extraction. Only the adapter SHAPE the ported
// omo layers consume is reconstructed here; signatures are iterated against
// the typed consumers (ProviderInstanceRegistry, ProviderAdapterRegistry,
// OmoDriver) until the effect graph typechecks.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";

import type { ProviderAdapterError } from "../Errors.ts";

export interface ProviderAdapterCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: {
    readonly env?: Record<string, string | undefined>;
    readonly shell?: string | boolean;
  };
}

export interface ProviderAdapterChild {
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exitCode: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

export interface ProviderAdapterShape<E = ProviderAdapterError> {
  readonly provider: string;
  readonly listSessions: () => Effect.Effect<ReadonlyArray<{ readonly threadId: string }>, E>;
  readonly hasSession: (input: { readonly threadId: string }) => Effect.Effect<boolean, E>;
  readonly stopSession: (input: { readonly threadId: string }) => Effect.Effect<void, E>;
  readonly stopAll: () => Effect.Effect<void, E>;
  readonly streamEvents: Stream.Stream<unknown>;
  readonly setSessionModel: (input: {
    readonly threadId: string;
    readonly modelId: string;
  }) => Effect.Effect<void, E>;
  readonly sendTurn: (input: {
    readonly threadId: string;
    readonly message: string;
  }) => Effect.Effect<{ readonly threadId: string }, E>;
  readonly interruptTurn: (input: { readonly threadId: string }) => Effect.Effect<void, E>;
  readonly respondToRequest: (input: {
    readonly threadId: string;
    readonly response: unknown;
  }) => Effect.Effect<void, E>;
  readonly respondToUserInput: (input: {
    readonly threadId: string;
    readonly response: unknown;
  }) => Effect.Effect<void, E>;
  readonly sendSubagentMessage: (input: {
    readonly threadId: string;
    readonly message: string;
  }) => Effect.Effect<void, E>;
  readonly readSubagentOutput: (input: { readonly threadId: string }) => Effect.Effect<unknown, E>;
  readonly cancelSubagentTask: (input: {
    readonly threadId: string;
    readonly taskId: string;
  }) => Effect.Effect<void, E>;
  readonly rollbackThread: (input: { readonly threadId: string }) => Effect.Effect<void, E>;
}

export class ProviderAdapter extends Context.Service<
  ProviderAdapter,
  { readonly make: (input: unknown) => Effect.Effect<ProviderAdapterShape> }
>() {}

export type ProviderAdapterSchemas = ReadonlyArray<Schema.Schema.All>;
