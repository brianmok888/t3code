import {
  ProviderDriverKind,
  type OmoSettings,
  type ServerProviderMcpServer,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "../../vendor/EffectUnstableProcess.ts";

import {
  buildServerProvider,
  type ProviderProbeResult,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { OmoSharedProcessFactory } from "./OmoAdapter.ts";
import {
  acquireOmoControlSession,
  discoverModelsInSession,
  discoverViaSharedProcess,
  discoveryFailureFromUnknown,
} from "./OmoModelDiscovery.ts";
import { discoverSkillsInSession, NO_SURFACES } from "./OmoSkillDiscovery.ts";
import { makeOmoSharedProcess } from "./OmoSharedProcess.ts";
import { type OmoSharedProcess, type OmoSharedProcessError } from "../omo/omoRpcConnection.ts";
import { probeVersion } from "./OmoVersionProbe.ts";

export { OMO_NO_MODELS_DIAGNOSTIC, OMO_UNAUTHENTICATED_MESSAGE } from "./OmoModelDiscovery.ts";
export { OMO_NOT_FOUND_MESSAGE } from "./OmoVersionProbe.ts";

const PROVIDER = ProviderDriverKind.make("omo");

export const OMO_PROVIDER_PRESENTATION = {
  displayName: "OmO",
  liveModelSwitch: true,
} as const satisfies ServerProviderPresentation;

export const OMO_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: PROVIDER,
  packageName: "omo-ai",
});

export interface OmoProbeOutcome {
  readonly probe: ProviderProbeResult;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly extensions: ReadonlyArray<ServerProviderSkill>;
  readonly mcpServers: ReadonlyArray<ServerProviderMcpServer>;
  readonly enabled: boolean;
}

type OmoProviderEnv = ChildProcessSpawner | Scope.Scope;

export type CheckOmoProviderStatusOptions = {
  readonly environment?: NodeJS.ProcessEnv;
  /** Visible runtime-selection diagnostic, notably override fallback. */
  readonly diagnostic?: string;
  /** Factory for the shared multi-session process used by the capability gate. */
  readonly makeSharedProcess?: OmoSharedProcessFactory;
  /** Long-lived adapter-owned supervisor; status and discovery must reuse it. */
  readonly sharedProcess?: OmoSharedProcess;
};

/**
 * Typed error raised when the omo binary does not support multi-session mode.
 * Produced by the `get_protocol_info` capability gate (D1): an old binary either
 * returns an error response (unknown command) or omits the `multi_session`
 * capability. The raw version string is carried as DIAGNOSTIC only — the gate
 * never parses semver or matches error strings.
 */
export class OmoMultiSessionUnsupported extends Schema.TaggedError<OmoMultiSessionUnsupported>()(
  "OmoMultiSessionUnsupported",
  {
    /** Diagnostic: raw `omo --version` output, or null when the version probe was skipped. */
    version: Schema.NullOr(Schema.String),
    /** Why the gate failed: "error-response" (binary rejects get_protocol_info) or "missing-capability". */
    reason: Schema.String,
  },
) {
  override get message(): string {
    return OMO_MULTI_SESSION_UNSUPPORTED_MESSAGE;
  }
}

/**
 * Minimum omo version that ships multi-session mode support. The gate does
 * NOT parse semver — this string appears only in the actionable degraded
 * message so users know what to upgrade to. The real version probe output is
 * captured as diagnostic evidence separately.
 */
export const OMO_MINIMUM_MULTI_SESSION_VERSION = "2026.7.22-2";

export const OMO_MULTI_SESSION_UNSUPPORTED_MESSAGE =
  "OmO multi-session mode is required. Update omo-ai to the latest version, then refresh the provider.";

const MULTI_SESSION_CAPABILITY = "multi_session";

/**
 * Run the `get_protocol_info` capability gate against a shared multi-session
 * process.
 *
 * Gate rules (D1, no semver parsing, no error-string matching):
 * - `success: true` with `data.capabilities` containing `"multi_session"` → pass.
 * - `success: false` (old binary rejects the command) → `error-response` failure.
 *   The shared process converts `success:false` responses into
 *   `OmoSharedProcessRequestFailed`; when the failing command is
 *   `get_protocol_info`, the gate treats it as an old binary (not a transport
 *   fault) — the error DETAIL string is never inspected.
 * - `success: true` but `"multi_session"` absent → `missing-capability` failure.
 * - Other transport failures (spawn/exit) propagate as `OmoSharedProcessError`.
 */
export const probeMultiSessionCapability = (
  shared: OmoSharedProcess,
): Effect.Effect<void, OmoMultiSessionUnsupported | OmoSharedProcessError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const responseResult = yield* shared
      .request({ type: "get_protocol_info" }, "probe")
      .pipe(Effect.result);
    if (Result.isFailure(responseResult)) {
      const error = responseResult.failure;
      // The shared process converts `success:false` responses into
      // OmoSharedProcessRequestFailed. For get_protocol_info specifically,
      // a request failure means the binary rejected the command (old binary),
      // which is a gate failure, NOT a transport error. The error detail
      // string is never inspected (no error-string matching).
      if (error._tag === "OmoSharedProcessRequestFailed") {
        return yield* new OmoMultiSessionUnsupported({
          version: null,
          reason: "error-response",
        });
      }
      return yield* error;
    }
    const response = responseResult.success;
    const data = response.data;
    const capabilities =
      data !== null &&
      typeof data === "object" &&
      Array.isArray((data as Record<string, unknown>).capabilities)
        ? ((data as Record<string, unknown>).capabilities as readonly unknown[])
        : [];
    if (!capabilities.includes(MULTI_SESSION_CAPABILITY)) {
      return yield* new OmoMultiSessionUnsupported({
        version: null,
        reason: "missing-capability",
      });
    }
  });

const failureProbe = (input: {
  readonly installed: boolean;
  readonly status: "error" | "warning";
  readonly auth: ProviderProbeResult["auth"];
  readonly message: string | undefined;
}): ProviderProbeResult => ({
  installed: input.installed,
  version: null,
  status: input.status,
  auth: input.auth,
  ...(input.message !== undefined ? { message: input.message } : {}),
});

/** Extract a human-readable detail string from a shared-process transport error. */
const sharedProcessErrorDetail = (error: OmoSharedProcessError): string => {
  switch (error._tag) {
    case "OmoSharedProcessSpawnFailed":
      return `failed to spawn omo at '${error.binaryPath}'`;
    case "OmoSharedProcessExited":
      return `process exited (epoch ${error.epoch}, code ${error.exitCode ?? "null"})${error.stderrTail.length > 0 ? `: ${error.stderrTail.slice(0, 200)}` : ""}`;
    case "OmoSharedProcessRequestFailed":
      return `${error.command}: ${error.detail}`;
  }
};

export const probeOmoProvider = (
  settings: OmoSettings,
  options?: CheckOmoProviderStatusOptions,
): Effect.Effect<OmoProbeOutcome, never, OmoProviderEnv> =>
  Effect.gen(function* () {
    const environment = options?.environment ?? process.env;
    const outcome = (
      probe: ProviderProbeResult,
      models: ReadonlyArray<ServerProviderModel> = [],
      skills: ReadonlyArray<ServerProviderSkill> = [],
      extensions: ReadonlyArray<ServerProviderSkill> = [],
      mcpServers: ReadonlyArray<ServerProviderMcpServer> = [],
      slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [],
    ): OmoProbeOutcome => ({
      enabled: settings.enabled,
      models,
      skills,
      slashCommands,
      extensions,
      mcpServers,
      probe:
        options?.diagnostic === undefined
          ? probe
          : {
              ...probe,
              message:
                probe.message === undefined
                  ? options.diagnostic
                  : `${options.diagnostic}: ${probe.message}`,
            },
    });
    if (!settings.enabled) {
      return outcome(
        failureProbe({
          installed: false,
          status: "warning",
          auth: { status: "unknown" },
          message: "Omo is disabled in OmO settings.",
        }),
      );
    }
    const versionResult = yield* probeVersion(settings.binaryPath, environment);
    if (Result.isFailure(versionResult)) {
      return outcome(versionResult.failure);
    }
    const version = versionResult.success;
    const makeSharedProcess = options?.makeSharedProcess ?? makeOmoSharedProcess;
    // The gate and discovery share ONE multi-session process: create it in a
    // short-lived scope, run get_protocol_info, then discover models through the
    // same process (open_session -> get_available_models -> close_session), and
    // tear it down when done. This preserves the one-process-per-probe invariant.
    const probeOutcome = Effect.gen(function* () {
      const shared: OmoSharedProcess =
        options?.sharedProcess ??
        (yield* makeSharedProcess({
          binaryPath: settings.binaryPath,
          cwd: process.cwd(),
          ...(environment === undefined ? {} : { env: environment }),
        }));
      const capabilityResult = yield* probeMultiSessionCapability(shared).pipe(Effect.result);
      if (Result.isFailure(capabilityResult)) {
        const gateError = capabilityResult.failure;
        const isCapabilityGateFailure = gateError._tag === "OmoMultiSessionUnsupported";
        return outcome(
          failureProbe({
            installed: true,
            status: "error",
            auth: { status: "unknown" },
            message: isCapabilityGateFailure
              ? `${OMO_MULTI_SESSION_UNSUPPORTED_MESSAGE} (detected: ${(gateError as OmoMultiSessionUnsupported).reason}; minimum omo ${OMO_MINIMUM_MULTI_SESSION_VERSION}; diagnostic version: ${version})`
              : `omo shared-process capability probe failed: ${sharedProcessErrorDetail(gateError as OmoSharedProcessError)}`,
          }),
        );
      }
      // Model and runtime-surface discovery share one temporary control
      // session. Opening a project session initializes the runtime's project
      // graph and is the dominant provider-check cost, so repeating it for
      // skills delayed every healthy startup by several seconds.
      //
      // Acquiring that session is part of the BEST-EFFORT half: skills degrade
      // to [] on any failure, so an unusable project graph must never take a
      // model-capable provider down. Only model discovery fails the probe.
      const inventoryResult = yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionResult = yield* acquireOmoControlSession(shared, {
            cwd: process.cwd(),
          }).pipe(Effect.result);
          if (Result.isFailure(sessionResult)) {
            yield* Effect.logWarning(
              `omo control session unavailable; runtime inventory degraded to []: ${String(sessionResult.failure)}`,
            );
            const modelsOnly = yield* discoverViaSharedProcess(shared);
            return Result.isFailure(modelsOnly)
              ? { _tag: "Failure" as const, probe: modelsOnly.failure }
              : {
                  _tag: "Success" as const,
                  models: modelsOnly.success,
                  surfaces: NO_SURFACES,
                };
          }
          const routingHandle = sessionResult.success;
          const modelsResult = yield* discoverModelsInSession(shared, routingHandle);
          if (Result.isFailure(modelsResult)) {
            return { _tag: "Failure" as const, probe: modelsResult.failure };
          }
          // Skills are best-effort: discovery degrades to [] with a warning on
          // any failure, so a get_commands problem can never take ready down.
          const surfaces = yield* discoverSkillsInSession(shared, routingHandle);
          return { _tag: "Success" as const, models: modelsResult.success, surfaces };
        }),
      ).pipe(Effect.result);
      if (Result.isFailure(inventoryResult)) {
        return outcome({ ...discoveryFailureFromUnknown(inventoryResult.failure), version });
      }
      if (inventoryResult.success._tag === "Failure") {
        return outcome({ ...inventoryResult.success.probe, version });
      }
      const { models, surfaces } = inventoryResult.success;
      return outcome(
        { installed: true, version, status: "ready", auth: { status: "authenticated" } },
        models,
        surfaces.skills,
        surfaces.extensions,
        surfaces.mcpServers,
        surfaces.slashCommands,
      );
    });
    return yield* options?.sharedProcess === undefined ? Effect.scoped(probeOutcome) : probeOutcome;
  });

export const checkOmoProviderStatus = Effect.fn("checkOmoProviderStatus")(function* (
  settings: OmoSettings,
  options?: CheckOmoProviderStatusOptions,
): Effect.fn.Return<ServerProviderDraft, never, OmoProviderEnv> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const outcome = yield* probeOmoProvider(settings, options);
  return buildServerProvider({
    presentation: OMO_PROVIDER_PRESENTATION,
    enabled: outcome.enabled,
    checkedAt,
    models: outcome.models,
    extensions: outcome.extensions,
    mcpServers: outcome.mcpServers,
    skills: outcome.skills,
    slashCommands: outcome.slashCommands,
    probe: outcome.probe,
  });
});
