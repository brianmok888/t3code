import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "../../vendor/EffectUnstableProcess.ts";

import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { makeOmoChildEnvironment } from "../omo/omoChildEnvironment.ts";
import {
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  nonEmptyTrimmed,
  spawnAndCollect,
  type CommandResult,
  type ProviderProbeResult,
} from "../providerSnapshot.ts";

export const OMO_NOT_FOUND_MESSAGE =
  "omo binary not found (install omo-ai globally or set binaryPath)";

const STDERR_MESSAGE_LIMIT = 512;
const OMO_SEMVER_PATTERN = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[\s)]|$)/g;
const OMO_ENGINE_VERSION_PATTERN =
  /\(engine:\s*(?:senpi|omo)\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)/i;

export const extractOmoSemanticVersion = (output: string): string | undefined => {
  const engineVersion = output.match(OMO_ENGINE_VERSION_PATTERN)?.[1];
  if (engineVersion !== undefined) return engineVersion;
  const matches = [...output.trim().matchAll(OMO_SEMVER_PATTERN)];
  return matches.at(-1)?.[1];
};

export const isOmoVersionCompatible = (output: string | undefined, minimum: string): boolean => {
  if (output === undefined) return false;
  const version = extractOmoSemanticVersion(output);
  return version !== undefined && compareSemverVersions(version, minimum) >= 0;
};

export const boundedMessage = (detail: string | undefined): string | undefined => {
  const trimmed = nonEmptyTrimmed(detail);
  if (trimmed === undefined) return undefined;
  return trimmed.length <= STDERR_MESSAGE_LIMIT
    ? trimmed
    : `${trimmed.slice(0, STDERR_MESSAGE_LIMIT)}...`;
};

export const versionFailure = (
  message: string | undefined,
  installed = true,
): ProviderProbeResult => ({
  installed,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  ...(message !== undefined ? { message } : {}),
});

export const classifyVersionProbe = (
  probe: Result.Result<Option.Option<CommandResult>, unknown>,
): Result.Result<string, ProviderProbeResult> => {
  if (Result.isFailure(probe)) {
    const missing = isCommandMissingCause(probe.failure);
    return Result.fail(
      versionFailure(
        missing ? OMO_NOT_FOUND_MESSAGE : boundedMessage(String(probe.failure)),
        !missing,
      ),
    );
  }
  if (Option.isNone(probe.success)) {
    return Result.fail(versionFailure("Timed out while running `omo --version`."));
  }
  const result = probe.success.value;
  if (result.code !== 0) {
    return Result.fail(
      versionFailure(
        boundedMessage(detailFromResult(result)) ?? `Command exited with code ${result.code}.`,
      ),
    );
  }
  const version = nonEmptyTrimmed(result.stdout);
  return version === undefined
    ? Result.fail(versionFailure("Unable to determine omo version from `omo --version` output."))
    : Result.succeed(version);
};

export const probeVersion = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<Result.Result<string, ProviderProbeResult>, never, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const childEnvironment = makeOmoChildEnvironment(environment, undefined);
    const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: childEnvironment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: childEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
    Effect.map(classifyVersionProbe),
  );
