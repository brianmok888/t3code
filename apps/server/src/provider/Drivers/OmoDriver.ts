/**
 * OmoDriver — built-in driver for the native omo JSONL RPC provider.
 *
 * One `create()` call bundles:
 *   - `snapshot`   — a managed `ServerProviderShape` whose checks run the
 *                    omo probe (version + ephemeral model discovery);
 *   - `adapter`    — the omo session/turn/dialog runtime backed by one
 *                    `omo --mode rpc` child per thread;
 *   - `textGeneration` — commit/PR/branch/thread-title generation via one-shot
 *                    `omo -p <prompt> --model <provider/id> --no-tools
 *                    --no-extensions` runs whose JSON stdout is decoded
 *                    against the shared prompt output schemas.
 *
 * Omo is manual-only maintenance: no version advisory, no update checks,
 * so the driver needs no HttpClient and forks no enrichment fiber.
 *
 * @module provider/Drivers/OmoDriver
 */
import {
  CommandId,
  type OrchestrationV2Command,
  ProviderDriverKind,
  OmoSettings,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "../../vendor/EffectUnstableProcess.ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmoAdapter, type OmoAdapterOptions } from "../Layers/OmoAdapter.ts";
import {
  checkOmoProviderStatus,
  OMO_MAINTENANCE_CAPABILITIES,
  OMO_MINIMUM_MULTI_SESSION_VERSION,
  OMO_PROVIDER_PRESENTATION,
} from "../Layers/OmoProvider.ts";
import { makeOmoTextGeneration } from "../Layers/OmoTextGeneration.ts";
import { isOmoVersionCompatible } from "../Layers/OmoVersionProbe.ts";
import { readOmoAgentSettings } from "../omo/omoAgentSettings.ts";
import type { OmoSharedProcess } from "../omo/omoRpcConnection.ts";
import {
  OMO_DEFAULT_BINARY_PATH,
  OmoRuntimeBinary,
  type OmoRuntimeBinaryError,
  type OmoRuntimeBinaryResolution,
} from "../omo/OmoRuntimeBinary.ts";
import * as OmoRuntimeBinaryService from "../omo/OmoRuntimeBinary.ts";
import {
  makeOmoAgentSettingsEnrichment,
  projectOmoAgentSettings,
} from "../omo/omoSettingsProjection.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  buildServerProvider,
  type ProviderProbeResult,
  type ServerProviderDraft,
  withInstanceIdentity,
} from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeOmoChildEnvironment } from "../omo/omoChildEnvironment.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOmoSettings = Schema.decodeSync(OmoSettings);

const DRIVER_KIND = ProviderDriverKind.make("omo");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export const OMO_OVERRIDE_INCOMPATIBLE_DIAGNOSTIC =
  "override incompatible, falling back to bundled";

export interface OmoEffectiveConfigResolution {
  readonly config: OmoSettings;
  readonly resolution: OmoRuntimeBinaryResolution;
  readonly diagnostic: string | undefined;
  readonly fallbackChain: ReadonlyArray<OmoRuntimeBinaryResolution["source"]>;
}

export const resolveOmoEffectiveConfig = Effect.fn("OmoDriver.resolveEffectiveConfig")(function* (
  config: OmoSettings,
  options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly runtimeBinary: OmoRuntimeBinary["Service"];
  },
): Effect.fn.Return<OmoEffectiveConfigResolution, OmoRuntimeBinaryError> {
  if (config.binaryPath === OMO_DEFAULT_BINARY_PATH) {
    const resolution = yield* options.runtimeBinary.resolve;
    return {
      config: { ...config, binaryPath: resolution.path },
      resolution,
      diagnostic: undefined,
      fallbackChain: [resolution.source],
    };
  }

  const overrideVersion = yield* options.runtimeBinary.probeVersion(
    config.binaryPath,
    options.environment,
  );
  if (isOmoVersionCompatible(overrideVersion, OMO_MINIMUM_MULTI_SESSION_VERSION)) {
    yield* Effect.logWarning("provider.omo.runtime.override.accepted", {
      path: config.binaryPath,
      version: overrideVersion,
      minimumVersion: OMO_MINIMUM_MULTI_SESSION_VERSION,
    });
    const resolution: OmoRuntimeBinaryResolution = {
      source: "user-setting",
      path: config.binaryPath,
      version: overrideVersion,
    };
    return {
      config,
      resolution,
      diagnostic: undefined,
      fallbackChain: ["user-setting"],
    };
  }

  yield* Effect.logWarning(OMO_OVERRIDE_INCOMPATIBLE_DIAGNOSTIC, {
    overridePath: config.binaryPath,
    overrideVersion: overrideVersion ?? "unknown",
    minimumVersion: OMO_MINIMUM_MULTI_SESSION_VERSION,
  });

  const resolution = yield* options.runtimeBinary.resolveBundled;
  return {
    config: { ...config, binaryPath: resolution.path },
    resolution,
    diagnostic: OMO_OVERRIDE_INCOMPATIBLE_DIAGNOSTIC,
    fallbackChain: ["user-setting", resolution.source],
  };
});

export type OmoRuntimeProjectionInput = Parameters<
  NonNullable<OmoAdapterOptions["onSteeringUpdated"]>
>[0];

/** Refresh the provider snapshot when Omo invalidates its loaded inventory. */
export const refreshOmoProviderOnLoadedSurfacesChanged = (
  sharedProcess: OmoSharedProcess,
  refreshProvider: Effect.Effect<unknown>,
): Effect.Effect<void> =>
  sharedProcess.records.pipe(
    Stream.filter(({ record }) => record.type === "loaded_surfaces_changed"),
    Stream.runForEach(() =>
      refreshProvider.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("omo runtime inventory refresh failed", { cause }),
        ),
      ),
    ),
  );

/** Build the typed provider-owned runtime projection command without casts. */
export const omoRuntimeUpdateCommand = (
  commandId: CommandId,
  input: OmoRuntimeProjectionInput,
): OrchestrationV2Command => ({
  type: "thread.runtime.update",
  commandId,
  threadId: input.threadId,
  steering: input.steering,
  activeMonitors: input.activeMonitors,
  subagents: input.subagents,
  ...(input.dagRuns === undefined ? {} : { dagRuns: input.dagRuns }),
  activeWorks: input.activeWorks,
  ulwActive: input.ulwActive,
  updatedAt: input.updatedAt,
});

export type OmoDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | OrchestrationEngineService;

const OMO_STEERING_COALESCE_INTERVAL = Duration.millis(400);

type OmoSteeringProjectionCoalescer = {
  readonly onUpdated: (input: OmoRuntimeProjectionInput) => Effect.Effect<void>;
  readonly flushThread: (threadId: OmoRuntimeProjectionInput["threadId"]) => Effect.Effect<void>;
  readonly flushAll: Effect.Effect<void>;
};

/** Coalesce noisy per-thread runtime snapshots while preserving the latest snapshot. */
export const makeOmoSteeringProjectionCoalescer = (
  dispatch: (input: OmoRuntimeProjectionInput) => Effect.Effect<void, never>,
): Effect.Effect<OmoSteeringProjectionCoalescer> =>
  Effect.gen(function* () {
    const pending = new Map<
      OmoRuntimeProjectionInput["threadId"],
      { readonly input: OmoRuntimeProjectionInput; readonly fiber: Fiber.Fiber<void> }
    >();

    const flushThread = (threadId: OmoRuntimeProjectionInput["threadId"]) =>
      Effect.gen(function* () {
        const entry = pending.get(threadId);
        if (entry === undefined) return;
        pending.delete(threadId);
        yield* Fiber.interrupt(entry.fiber);
        yield* dispatch(entry.input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("omo steering projection dispatch failed", { threadId, cause }),
          ),
        );
      });

    const schedule = (input: OmoRuntimeProjectionInput) => {
      const timer = Effect.sleep(OMO_STEERING_COALESCE_INTERVAL).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const latest = pending.get(input.threadId);
            if (latest === undefined) return Effect.void;
            pending.delete(input.threadId);
            return dispatch(latest.input);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("omo steering projection dispatch failed", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );
      return Effect.forkDetach(timer);
    };

    const onUpdated = (input: OmoRuntimeProjectionInput) =>
      Effect.gen(function* () {
        const existing = pending.get(input.threadId);
        if (existing !== undefined) yield* Fiber.interrupt(existing.fiber);
        const fiber = yield* schedule(input);
        pending.set(input.threadId, { input, fiber });
      });

    const flushAll = Effect.suspend(() =>
      Effect.forEach(Array.from(pending.keys()), flushThread, {
        concurrency: 1,
        discard: true,
      }),
    );

    return { onUpdated, flushThread, flushAll };
  });

const makePendingOmoProvider = (settings: OmoSettings): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const probe: ProviderProbeResult = settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          checking: true,
          auth: { status: "unknown" },
          message: "Checking omo availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Omo is disabled in OmO settings.",
        };
    return buildServerProvider({
      presentation: OMO_PROVIDER_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe,
    });
  });

export const OmoDriver: ProviderDriver<OmoSettings, OmoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OmO",
    supportsMultipleInstances: true,
  },
  configSchema: OmoSettings,
  defaultConfig: (): OmoSettings => decodeOmoSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const hostEnvironment = yield* HostProcessEnvironment;
      const processEnv = mergeProviderInstanceEnvironment(
        environment,
        makeOmoChildEnvironment(hostEnvironment, undefined),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        driver: DRIVER_KIND,
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const requestedConfig = { ...config, enabled } satisfies OmoSettings;
      const effectiveResolution =
        enabled || requestedConfig.binaryPath !== OMO_DEFAULT_BINARY_PATH
          ? yield* Effect.gen(function* () {
              const runtimeBinary = yield* OmoRuntimeBinaryService.make();
              return yield* resolveOmoEffectiveConfig(requestedConfig, {
                environment: processEnv,
                runtimeBinary,
              });
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to resolve Omo runtime: ${cause.message}`,
                    cause,
                  }),
              ),
            )
          : undefined;
      const effectiveConfig = effectiveResolution?.config ?? requestedConfig;

      const bootNonce = DateTime.toEpochMillis(yield* DateTime.now).toString(36);
      let goalProjectionSequence = 0;
      let steeringProjectionSequence = 0;
      const steeringCoalescer = yield* makeOmoSteeringProjectionCoalescer((input) => {
        const sequence = steeringProjectionSequence;
        steeringProjectionSequence += 1;
        return orchestrationEngine
          .dispatch(
            omoRuntimeUpdateCommand(CommandId.make(`omo-steering-${bootNonce}-${sequence}`), input),
          )
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("omo steering projection dispatch failed", {
                threadId: input.threadId,
                cause,
              }),
            ),
          );
      });
      yield* Effect.addFinalizer(() => steeringCoalescer.flushAll);
      const adapter = yield* makeOmoAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        // Boot-scoped nonce so turn/item ids from this adapter instance
        // never collide with ids minted by a previous server boot.
        instanceRunId: bootNonce,
        onGoalUpdated: (input) => {
          const sequence = goalProjectionSequence;
          goalProjectionSequence += 1;
          return orchestrationEngine
            .dispatch({
              type: "thread.goal.update",
              commandId: CommandId.make(`omo-goal-${bootNonce}-${sequence}`),
              threadId: input.threadId,
              goal: input.goal,
              updatedAt: input.updatedAt,
            })
            .pipe(
              Effect.asVoid,
              Effect.catchCause((cause) =>
                Effect.logWarning("omo goal projection dispatch failed", {
                  threadId: input.threadId,
                  cause,
                }),
              ),
            );
        },
        onSteeringUpdated: steeringCoalescer.onUpdated,
      });
      const textGeneration = makeOmoTextGeneration({
        binaryPath: effectiveConfig.binaryPath,
        environment: processEnv,
      });

      // Version checks use a short-lived `--version` child, but capability
      // probing and discovery reuse the adapter-owned RPC supervisor. A refresh
      // while sessions are active therefore cannot create a second rpc child.
      const checkProvider = checkOmoProviderStatus(effectiveConfig, {
        environment: processEnv,
        sharedProcess: adapter.sharedProcess,
        ...(effectiveResolution?.diagnostic === undefined
          ? {}
          : { diagnostic: effectiveResolution.diagnostic }),
      }).pipe(
        Effect.flatMap((draft) =>
          readOmoAgentSettings(processEnv).pipe(
            Effect.map((settings) => ({
              ...draft,
              ...projectOmoAgentSettings(draft.models, settings),
            })),
          ),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.scoped,
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmoSettings>>({
        maintenanceCapabilities: OMO_MAINTENANCE_CAPABILITIES,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOmoProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: (input) =>
          makeOmoAgentSettingsEnrichment(processEnv)(input).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, pathService),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Omo snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      yield* refreshOmoProviderOnLoadedSurfacesChanged(
        adapter.sharedProcess,
        snapshot.refresh,
      ).pipe(Effect.forkScoped);

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: {
          ...adapter,
          stopSession: (threadId) =>
            adapter
              .stopSession(threadId)
              .pipe(Effect.andThen(steeringCoalescer.flushThread(threadId))),
          stopAll: () => adapter.stopAll().pipe(Effect.andThen(steeringCoalescer.flushAll)),
        },
        setSessionModel: adapter.setSessionModel,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
