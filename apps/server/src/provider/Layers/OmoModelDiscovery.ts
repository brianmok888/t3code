import * as NodeOS from "node:os";

import { type OmoSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "../../vendor/EffectUnstableProcess.ts";

import { nonEmptyTrimmed, type ProviderProbeResult } from "../providerSnapshot.ts";
import { omoModelToServerModel, type OmoDiscoveredModel } from "../omo/omoMappers.ts";
import {
  type OmoSharedProcessError,
  type OmoSharedProcess,
  type OmoSharedProcessOptions,
} from "../omo/omoRpcConnection.ts";
import { normalizeWireThinkingInfo } from "../omo/omoThinkingLevels.ts";
import { makeOmoSharedProcess } from "./OmoSharedProcess.ts";

export const OMO_UNAUTHENTICATED_MESSAGE =
  "omo has no authenticated models - run omo and log in, then refresh";
export const OMO_NO_MODELS_DIAGNOSTIC = "No models available";

const STDERR_MESSAGE_LIMIT = 512;

const decodeAvailableModels = Schema.decodeUnknownResult(
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        provider: Schema.String,
        id: Schema.String,
        name: Schema.optional(Schema.String),
        reasoning: Schema.optional(Schema.Unknown),
        thinkingLevelMap: Schema.optional(Schema.Unknown),
        supportedThinkingLevels: Schema.optional(Schema.Unknown),
      }),
    ),
  }),
);

const boundedDiscoveryMessage = (detail: string | undefined): string | undefined => {
  const trimmed = nonEmptyTrimmed(detail);
  if (trimmed === undefined) return undefined;
  return trimmed.length <= STDERR_MESSAGE_LIMIT
    ? trimmed
    : `${trimmed.slice(0, STDERR_MESSAGE_LIMIT)}...`;
};

export const discoveryWarning = (
  auth: ProviderProbeResult["auth"],
  message: string,
): ProviderProbeResult => ({
  installed: true,
  version: null,
  status: "warning",
  auth,
  message,
});

export const classifyDiscoveredModels = (
  data: unknown,
): Result.Result<ReadonlyArray<ServerProviderModel>, ProviderProbeResult> => {
  const decoded = decodeAvailableModels(data);
  if (Result.isFailure(decoded)) {
    return Result.fail(
      discoveryWarning(
        { status: "unknown" },
        "omo returned an unparseable get_available_models response.",
      ),
    );
  }
  const discovered: ReadonlyArray<OmoDiscoveredModel> = decoded.success.models.map(
    (decodedModel) => {
      const normalized = normalizeWireThinkingInfo({
        reasoning: decodedModel.reasoning,
        thinkingLevelMap: decodedModel.thinkingLevelMap,
        supportedThinkingLevels: decodedModel.supportedThinkingLevels,
      });
      return {
        provider: decodedModel.provider,
        id: decodedModel.id,
        ...(decodedModel.name !== undefined ? { name: decodedModel.name } : {}),
        ...(normalized.reasoning === undefined ? {} : { reasoning: normalized.reasoning }),
        ...(normalized.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: normalized.thinkingLevelMap }),
        ...(normalized.supportedThinkingLevels === undefined
          ? {}
          : { supportedThinkingLevels: normalized.supportedThinkingLevels }),
      };
    },
  );
  return discovered.length === 0
    ? Result.fail(discoveryWarning({ status: "unauthenticated" }, OMO_UNAUTHENTICATED_MESSAGE))
    : Result.succeed(discovered.map(omoModelToServerModel));
};

type OmoProviderEnv = ChildProcessSpawner | Scope.Scope;

const SHARED_PROCESS_ERROR_TAGS = new Set([
  "OmoSharedProcessExited",
  "OmoSharedProcessSpawnFailed",
  "OmoSharedProcessRequestFailed",
]);

const isSharedProcessError = (error: unknown): error is OmoSharedProcessError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  SHARED_PROCESS_ERROR_TAGS.has((error as { _tag: string })._tag);

/**
 * Maps a shared-process error to the same {@link ProviderProbeResult} shape
 * that the old ephemeral-runtime path produced, preserving the
 * "No models available" → unauthenticated mapping.
 */
const sharedProcessFailureProbe = (error: OmoSharedProcessError): ProviderProbeResult => {
  if (
    error._tag === "OmoSharedProcessExited" &&
    error.stderrTail.includes(OMO_NO_MODELS_DIAGNOSTIC)
  ) {
    return discoveryWarning({ status: "unauthenticated" }, OMO_UNAUTHENTICATED_MESSAGE);
  }
  const stderrTail = "stderrTail" in error ? error.stderrTail : undefined;
  return discoveryWarning(
    { status: "unknown" },
    boundedDiscoveryMessage(stderrTail) ?? `omo model discovery failed: ${error._tag}`,
  );
};

export const discoveryFailureFromUnknown = (error: unknown): ProviderProbeResult => {
  if (isSharedProcessError(error)) return sharedProcessFailureProbe(error);
  return discoveryWarning({ status: "unknown" }, `omo model discovery failed: ${String(error)}`);
};

const SESSION_ROUTING_HANDLE = "sessionId";

/**
 * Extracts the routing handle from an open_session response's `data.sessionId`.
 * Throws a typed protocol error if the handle is absent so the caller's
 * `Effect.result` catches it and maps it to a discovery warning.
 */
export const extractRoutingHandle = (record: Readonly<Record<string, unknown>>): string => {
  const data = record.data;
  if (typeof data === "object" && data !== null && SESSION_ROUTING_HANDLE in data) {
    const handle = (data as Record<string, unknown>)[SESSION_ROUTING_HANDLE];
    if (typeof handle === "string") return handle;
  }
  throw new OmoDiscoveryProtocolError({
    detail: "open_session returned no routing handle",
  });
};

export class OmoDiscoveryProtocolError extends Schema.TaggedError<OmoDiscoveryProtocolError>()(
  "OmoDiscoveryProtocolError",
  { detail: Schema.String },
) {}

/** Acquire one temporary control session and close it on every scope exit. */
export const acquireOmoControlSession = (
  shared: OmoSharedProcess,
  options?: { readonly cwd?: string },
) =>
  Effect.acquireRelease(
    shared
      .request(
        {
          type: "open_session",
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        },
        "open_session",
      )
      .pipe(
        Effect.flatMap((response) =>
          Effect.try({
            try: () => extractRoutingHandle(response),
            catch: (cause) => new OmoDiscoveryProtocolError({ detail: String(cause) }),
          }),
        ),
      ),
    (handle) =>
      shared
        .request({ type: "close_session", sessionId: handle }, "close_session")
        .pipe(Effect.ignore),
  );

/** Discover models through an already-open control session. */
export const discoverModelsInSession = (shared: OmoSharedProcess, routingHandle: string) =>
  shared.request({ type: "get_available_models", sessionId: routingHandle }, "control").pipe(
    Effect.map((models) => {
      const data = typeof models.data === "object" && models.data !== null ? models.data : {};
      return classifyDiscoveredModels(data);
    }),
    Effect.catch((error) => Effect.succeed(Result.fail(discoveryFailureFromUnknown(error)))),
  );

/**
 * The control-session discovery flow: open_session (temporary, no
 * sessionPath) → get_available_models → close_session. Exposed so tests
 * can drive discovery against a pre-built shared process and observe spawn
 * counts without coupling to the outer scoped wrapper.
 */
export const discoverViaSharedProcess = (
  shared: OmoSharedProcess,
): Effect.Effect<
  Result.Result<ReadonlyArray<ServerProviderModel>, ProviderProbeResult>,
  never,
  never
> =>
  Effect.scoped(
    Effect.gen(function* () {
      // The control session is a resource. acquireRelease closes it on every
      // exit path, including interruption while get_available_models is in
      // flight; no probe session can outlive its discovery scope.
      const routingHandle = yield* acquireOmoControlSession(shared);
      return yield* discoverModelsInSession(shared, routingHandle);
    }),
  ).pipe(
    Effect.result,
    Effect.map((outcome) =>
      Result.isFailure(outcome)
        ? Result.fail(discoveryFailureFromUnknown(outcome.failure))
        : outcome.success,
    ),
  );

/**
 * Runs model discovery through the shared process using a temporary control
 * session: open_session (no sessionPath — ephemeral, no persistence) →
 * get_available_models → close_session. When the shared process is stopped
 * and desiredRunning=false, discovery starts it on demand via the
 * supervisor's demand() path. The shared process is scoped to this call so
 * the child is torn down after discovery completes (or fails).
 *
 */
export const discoverModels = (
  settings: OmoSettings,
  environment: NodeJS.ProcessEnv,
  options?: Pick<OmoSharedProcessOptions, "socketPath" | "socketTransport">,
): Effect.Effect<
  Result.Result<ReadonlyArray<ServerProviderModel>, ProviderProbeResult>,
  never,
  OmoProviderEnv
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const shared = yield* makeOmoSharedProcess({
        binaryPath: settings.binaryPath,
        cwd: NodeOS.tmpdir(),
        env: environment,
        ...(options?.socketPath === undefined ? {} : { socketPath: options.socketPath }),
        ...(options?.socketTransport === undefined
          ? {}
          : { socketTransport: options.socketTransport }),
      });
      return yield* discoverViaSharedProcess(shared);
    }),
  );
