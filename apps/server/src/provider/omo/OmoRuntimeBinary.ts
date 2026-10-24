/**
 * OmoRuntimeBinary - lazy per-spawn resolution of the omo runtime binary.
 *
 * Candidate tiers, highest precedence first:
 * 1. explicit `providers.omo.binaryPath` user setting (non-default value),
 * 2. `T3CODE_OMO_RUNTIME_PATH` via the HostProcessEnvironment bridge,
 * 3. bootstrap `ServerConfig.omoRuntimePath`,
 * 4. bundled `omo-runtime/<platform-key>/omo[.exe]`,
 * 5. PATH fallback for `omo`.
 *
 * Laziness: tiers 1-4 re-read server settings and re-stat the filesystem on
 * every resolve, so a swapped bundle (electron-updater) or an edited setting
 * is picked up on the next spawn. Resolution never launches the binary: the
 * provider's background health check owns the diagnostic `--version` probe,
 * while explicit user overrides call `probeVersion` before compatibility
 * fallback. Tier 5 goes through the shared shell command-resolution cache,
 * which may serve a PATH result for up to ~30s (self-healing TTL; accepted —
 * the explicit tiers that carry the electron-updater safety argument bypass
 * it entirely).
 *
 * A candidate that exists but is not executable fails hard with
 * OmoRuntimeBinaryNotExecutable instead of skipping to a lower tier —
 * deliberate: a broken explicit override or a corrupt bundled install must
 * surface loudly as a provider-unavailable reason, never silently fall back.
 */
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { makeOmoChildEnvironment } from "./omoChildEnvironment.ts";

export const OMO_RUNTIME_PATH_ENV = "T3CODE_OMO_RUNTIME_PATH";

/**
 * Fallback decoded by `makeBinaryPathSetting("omo")` when the user has not
 * explicitly set `providers.omo.binaryPath`. A decoded value equal to this is
 * never an explicit override.
 */
export const OMO_DEFAULT_BINARY_PATH = "omo";

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const VERSION_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

export const OmoRuntimeBinarySource = Schema.Literals([
  "user-setting",
  "env",
  "bootstrap",
  "bundled",
  "path",
]);
export type OmoRuntimeBinarySource = typeof OmoRuntimeBinarySource.Type;

export interface OmoRuntimeBinaryResolution {
  readonly source: OmoRuntimeBinarySource;
  readonly path: string;
  readonly version: string | undefined;
}

export class OmoRuntimeBinaryNotFound extends Schema.TaggedErrorClass<OmoRuntimeBinaryNotFound>()(
  "OmoRuntimeBinaryNotFound",
  {
    platform: Schema.String,
    architecture: Schema.String,
    candidates: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `omo runtime binary was not found for ${this.platform}/${this.architecture}.`;
  }
}

export class OmoRuntimeBinaryNotExecutable extends Schema.TaggedErrorClass<OmoRuntimeBinaryNotExecutable>()(
  "OmoRuntimeBinaryNotExecutable",
  {
    path: Schema.String,
    mode: Schema.Number,
  },
) {
  override get message(): string {
    return `omo runtime binary at '${this.path}' is not executable.`;
  }
}

export type OmoRuntimeBinaryError = OmoRuntimeBinaryNotFound | OmoRuntimeBinaryNotExecutable;

export class OmoRuntimeBinary extends Context.Service<
  OmoRuntimeBinary,
  {
    /**
     * Resolve the omo runtime binary for one spawn. Explicit tiers (user
     * setting, env, bootstrap, bundled) re-read settings and re-stat the
     * filesystem on every call, so their results are never cached across
     * spawns (electron-updater can swap the bundle). The PATH tier goes
     * through the shared shell command-resolution cache (≤30s TTL,
     * self-healing) — see the module docstring.
     */
    readonly resolve: Effect.Effect<OmoRuntimeBinaryResolution, OmoRuntimeBinaryError>;
    /** Resolve only packaged-runtime tiers, skipping user, env, and PATH overrides. */
    readonly resolveBundled: Effect.Effect<OmoRuntimeBinaryResolution, OmoRuntimeBinaryError>;
    /** Run the resolver's bounded, force-killing diagnostic probe for an explicit path. */
    readonly probeVersion: (
      binaryPath: string,
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<string | undefined>;
  }
>()("t3/provider/omo/OmoRuntimeBinary") {}

/**
 * Directories searched for the bundled `omo-runtime/<platform-key>/omo[.exe]`
 * candidate. `null` (the default) uses the built-in search dirs derived from
 * this module's location; tests override with fixture directories.
 */
export const OmoRuntimeBundledSearchDirs = Context.Reference<ReadonlyArray<string> | null>(
  "t3/provider/omo/OmoRuntimeBundledSearchDirs",
  {
    defaultValue: () => null,
  },
);

export function omoRuntimePlatformKey(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): string | undefined {
  if (
    (platform !== "darwin" && platform !== "linux" && platform !== "win32") ||
    (architecture !== "arm64" && architecture !== "x64")
  ) {
    return undefined;
  }
  return `${platform}-${architecture}`;
}

export const make = Effect.fn("provider/omo.runtimeBinary.make")(function* () {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostEnvironment = yield* HostProcessEnvironment;
  const bundledSearchDirsOverride = yield* OmoRuntimeBundledSearchDirs;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const executableName = platform === "win32" ? "omo.exe" : "omo";
  const platformKey = omoRuntimePlatformKey(platform, architecture);
  const bundledSearchDirs = bundledSearchDirsOverride ?? [
    // Bundle-adjacent layout: omo-runtime/ sits next to the server entry.
    path.resolve(import.meta.dirname, "omo-runtime"),
    // Repo dev layout: <repo>/omo-runtime produced by the runtime toolchain
    // (apps/server/src/provider/omo -> five levels up is the repo root).
    path.resolve(import.meta.dirname, "../../../../../omo-runtime"),
  ];

  // Best-effort `--version` probe for support diagnostics. Any failure
  // (spawn error, non-zero exit, timeout, empty output) degrades to
  // `undefined`; it never fails resolution.
  const probeVersion = (
    binaryPath: string,
    environment: NodeJS.ProcessEnv = hostEnvironment,
  ): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const childEnvironment = makeOmoChildEnvironment(environment, undefined);
      const spawnCommand = yield* resolveSpawnCommand(binaryPath, ["--version"], {
        env: childEnvironment,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: childEnvironment,
          shell: spawnCommand.shell,
          killSignal: "SIGTERM",
          forceKillAfter: Duration.seconds(1),
        }),
      );
      // Keep probe cleanup explicit at this scope boundary (matching the
      // providerMaintenanceRunner pattern). The kill options must be passed
      // here as well as on the command: handle-level kill calls do not inherit
      // command options, and a SIGTERM-resistant child requires escalation.
      yield* Effect.addFinalizer(() =>
        child
          .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(1) })
          .pipe(Effect.ignore),
      );
      const [stdout, , exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: VERSION_PROBE_MAX_OUTPUT_BYTES,
          }),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) return undefined;
      const version = stdout.text.trim();
      return version.length > 0 ? version : undefined;
    }).pipe(
      Effect.scoped,
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const logResolved = (resolution: OmoRuntimeBinaryResolution) =>
    Effect.logInfo("provider.omo.runtime.resolved", {
      source: resolution.source,
      path: resolution.path,
      version: resolution.version ?? "unknown",
    });

  type Candidate = {
    readonly source: OmoRuntimeBinarySource;
    readonly path: string;
  };

  const packagedCandidates = (): Array<Candidate> => {
    const candidates: Array<Candidate> = [];
    const bootstrapBinaryPath = config.omoRuntimePath;
    if (typeof bootstrapBinaryPath === "string" && bootstrapBinaryPath.trim().length > 0) {
      candidates.push({ source: "bootstrap", path: bootstrapBinaryPath });
    }
    if (platformKey !== undefined) {
      for (const searchDir of bundledSearchDirs) {
        candidates.push({
          source: "bundled",
          path: path.join(searchDir, platformKey, executableName),
        });
      }
    }
    return candidates;
  };

  const resolveCandidates = (candidates: ReadonlyArray<Candidate>) =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        const stat = yield* fileSystem.stat(candidate.path).pipe(Effect.orElseSucceed(() => null));
        if (stat === null || stat.type !== "File") continue;

        if (platform !== "win32" && (stat.mode & 0o111) === 0) {
          const error = new OmoRuntimeBinaryNotExecutable({
            path: candidate.path,
            mode: stat.mode,
          });
          yield* Effect.logWarning("provider.omo.runtime.resolve-failed", {
            source: candidate.source,
            path: candidate.path,
            reason: error.message,
          });
          return yield* error;
        }

        const resolution: OmoRuntimeBinaryResolution = {
          source: candidate.source,
          path: candidate.path,
          version: undefined,
        };
        yield* logResolved(resolution);
        return resolution;
      }
      return undefined;
    });

  const failNotFound = (candidates: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const error = new OmoRuntimeBinaryNotFound({ platform, architecture, candidates });
      yield* Effect.logWarning("provider.omo.runtime.resolve-failed", {
        reason: error.message,
        candidates,
      });
      return yield* error;
    });

  const resolveBundled: OmoRuntimeBinary["Service"]["resolveBundled"] = Effect.gen(function* () {
    const candidates = packagedCandidates();
    const resolution = yield* resolveCandidates(candidates);
    if (resolution !== undefined) return resolution;
    return yield* failNotFound(candidates.map((candidate) => candidate.path));
  });

  const resolve: OmoRuntimeBinary["Service"]["resolve"] = Effect.gen(function* () {
    // Settings are read per resolution so a binaryPath edit takes effect on
    // the next spawn without a server restart. A settings-read failure skips
    // the user tier instead of killing resolution.
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("provider.omo.runtime.settings-read-failed", {
          error: String(error),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

    const candidates: Array<Candidate> = [];
    const userBinaryPath = settings?.providers.omo.binaryPath;
    if (
      userBinaryPath !== undefined &&
      userBinaryPath.trim().length > 0 &&
      userBinaryPath !== OMO_DEFAULT_BINARY_PATH
    ) {
      candidates.push({ source: "user-setting", path: userBinaryPath });
    }
    const envBinaryPath = hostEnvironment[OMO_RUNTIME_PATH_ENV];
    if (typeof envBinaryPath === "string" && envBinaryPath.trim().length > 0) {
      candidates.push({ source: "env", path: envBinaryPath });
    }
    candidates.push(...packagedCandidates());

    const explicitResolution = yield* resolveCandidates(candidates);
    if (explicitResolution !== undefined) return explicitResolution;

    const pathBinary = yield* resolveCommandPath(OMO_DEFAULT_BINARY_PATH, {
      env: hostEnvironment,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessEnvironment, hostEnvironment),
      Effect.option,
    );
    if (Option.isSome(pathBinary)) {
      const resolution: OmoRuntimeBinaryResolution = {
        source: "path",
        path: pathBinary.value,
        version: undefined,
      };
      yield* logResolved(resolution);
      return resolution;
    }

    return yield* failNotFound([
      ...candidates.map((candidate) => candidate.path),
      `${OMO_DEFAULT_BINARY_PATH} (PATH)`,
    ]);
  });

  return OmoRuntimeBinary.of({ resolve, resolveBundled, probeVersion });
});

export const layer = Layer.effect(OmoRuntimeBinary, make());
