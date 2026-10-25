import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { writeAgentConfig } from "./omoAgentConfigService.ts";

/**
 * Mirror the user's telemetry decision (ServerSettings.telemetryConsent) into
 * the agent's user-level omo config (`telemetry.enabled`), which the bundled
 * omo runtime — and any CLI sharing that machine — both honor natively.
 * Absent consent (disclosure not yet answered) writes nothing: the opt-out
 * model stays on until the user decides.
 */

export type OmoTelemetryConsent = "accepted" | "declined";

export const writeOmoTelemetryConsent = (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly projectDir: string;
  readonly consent: OmoTelemetryConsent;
}): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  writeAgentConfig(input.environment, input.projectDir, {
    file: "omoConfigUser",
    edits: [{ path: ["telemetry", "enabled"], value: input.consent === "accepted" }],
  }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("omo.telemetry.consent_sync_failed", {
        cause: String(cause),
      }),
    ),
  );

export const startOmoTelemetryConsentSync = (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly projectDir: string;
}): Effect.Effect<
  void,
  never,
  ServerSettingsService | FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    let synced: OmoTelemetryConsent | undefined;

    const apply = (
      consent: OmoTelemetryConsent | undefined,
    ): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        if (consent === undefined || synced === consent) return;
        synced = consent;
        yield* writeOmoTelemetryConsent({
          environment: options.environment,
          projectDir: options.projectDir,
          consent,
        });
      });

    // Subscribe before the snapshot so a decision taken between the two is not lost.
    yield* Stream.runForEach(settings.streamChanges, (change) =>
      apply((change as { telemetryConsent?: OmoTelemetryConsent }).telemetryConsent),
    ).pipe(Effect.forkScoped);
    const snapshot = yield* settings.getSettings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("omo.telemetry.consent_snapshot_failed", {
          cause: String(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    yield* apply(
      (snapshot as { telemetryConsent?: OmoTelemetryConsent } | undefined)?.telemetryConsent,
    );
  });
