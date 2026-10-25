/**
 * Omo agent settings file access.
 *
 * Omo persists user configuration at `<coding-agent-dir>/settings.json`.
 * The coding-agent directory mirrors omo-native's canonical resolution
 * (`packages/omo-native/bin/lib/agent-dir.js`): the first non-empty of
 * `$OMO_CODING_AGENT_DIR`, `$SENPI_CODING_AGENT_DIR`, `$PI_CODING_AGENT_DIR`,
 * otherwise `~/.omo/agent`. Diverging here would make the desktop app read a
 * different directory than the agent writes, which presents as erased
 * settings. This module is the single lenient read path for that file: any
 * read/parse/shape failure degrades to `Option.none`, letting callers fall
 * back to static defaults. Unknown keys are ignored so the reader keeps
 * working as omo's settings schema grows.
 *
 * @module provider/omo/omoAgentSettings
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import lockfile from "proper-lockfile";

import type { OmoModelRef } from "./omoMappers.ts";
import type { OmoThinkingLevel } from "./omoRpcProtocol.ts";

/** Env names carrying an explicit agent-state directory, most specific first. */
const CODING_AGENT_DIR_ENV_NAMES = [
  "OMO_CODING_AGENT_DIR",
  "SENPI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
] as const;
const OMO_SETTINGS_FILE = "settings.json";

export const OmoAgentSettings = Schema.Struct({
  defaultProvider: Schema.optional(Schema.String),
  defaultModel: Schema.optional(Schema.String),
  favoriteModels: Schema.optional(Schema.Array(Schema.String)),
  defaultThinkingLevel: Schema.optional(Schema.Unknown),
  // These stay Unknown so a malformed senpi-owned map cannot poison otherwise
  // valid desktop settings. Entries are validated where they are resolved.
  modelThinkingLevels: Schema.optional(Schema.Unknown),
  modelLastOnThinkingLevels: Schema.optional(Schema.Unknown),
});
export type OmoAgentSettings = typeof OmoAgentSettings.Type;

const SettingsObjectSchema = Schema.Record(Schema.String, Schema.Unknown);

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeOmoAgentSettings = Schema.decodeUnknownResult(OmoAgentSettings);
const decodeSettingsObject = Schema.decodeUnknownResult(SettingsObjectSchema);
const encodeSettingsObject = Schema.encodeUnknownResult(fromJsonStringPretty(SettingsObjectSchema));

export class OmoAgentSettingsWriteError extends Schema.TaggedError<OmoAgentSettingsWriteError>()(
  "OmoAgentSettingsWriteError",
  {
    settingsPath: Schema.String,
    operation: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} omo settings at ${this.settingsPath}`;
  }
}

export const nonEmptyTrimmed = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

export const resolveOmoCodingAgentDir = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    for (const name of CODING_AGENT_DIR_ENV_NAMES) {
      const override = nonEmptyTrimmed(environment[name]);
      if (override !== undefined) return override;
    }
    return path.join(NodeOS.homedir(), ".omo", "agent");
  });

export const readOmoAgentSettings = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<Option.Option<OmoAgentSettings>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* resolveOmoCodingAgentDir(environment);
    const settingsPath = path.join(dir, OMO_SETTINGS_FILE);

    const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
    if (Option.isNone(raw)) return Option.none();

    const json = decodeJson(raw.value);
    if (Result.isFailure(json)) return Option.none();

    const decoded = decodeOmoAgentSettings(json.success);
    if (Result.isFailure(decoded)) return Option.none();

    return Option.some(decoded.success);
  });

/**
 * Emits one immediate attach tick, then a debounced tick for every change in
 * the coding-agent directory. Ticks are intentionally unfiltered: platform
 * watchers variously report child writes as directory-level updates,
 * create/remove pairs, or renames, so the only faithful signal is "something
 * changed — re-read". Consumers re-read `settings.json` leniently and dedupe
 * downstream, making stray ticks harmless. Watch errors degrade to "no
 * events", keeping the initial attach tick so the current file state is
 * still applied once. `omoWatchTicks` is the testable plumbing;
 * `watchOmoAgentSettings` binds it to the real watcher.
 */
export const omoWatchTicks = <E, R>(
  events: Stream.Stream<unknown, E, R>,
): Stream.Stream<void, never, R> =>
  Stream.merge(
    Stream.succeed<void>(undefined),
    events.pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.map(() => undefined),
      Stream.catchCause(() => Stream.empty),
    ),
  );

/**
 * Binds `omoWatchTicks` to the real coding-agent directory watcher.
 *
 * The directory is created (recursively, best-effort) before `fs.watch`
 * attaches: `fs.watch` fails with `NotFound` on a missing path, and
 * `omoWatchTicks` swallows that failure into "no events", which would
 * permanently degrade the stream to the single attach tick. Omo may not
 * have run yet when the app boots, so an absent directory is the normal
 * first-run state — without this the very first favorites write would never
 * republish (the write creates the directory only *after* the watcher is
 * already dead). Directory creation failures are ignored: the watch then
 * fails as before and the initial attach tick still applies current state.
 */
export const watchOmoAgentSettings = (
  environment: NodeJS.ProcessEnv,
): Stream.Stream<void, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* resolveOmoCodingAgentDir(environment);
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore);
      return omoWatchTicks(fs.watch(dir));
    }),
  );

/**
 * Atomically replaces the `favoriteModels` key in `<dir>/settings.json`
 * (tmp-file + rename, matching omo's own two-space formatting and its
 * `undefined`-means-unset convention: an empty list removes the key). All
 * other keys are preserved. A corrupt existing file is never clobbered —
 * the write fails with `OmoAgentSettingsWriteError` and the file is left
 * byte-identical.
 */
export const writeOmoFavoriteModels = (
  environment: NodeJS.ProcessEnv,
  favoriteModels: ReadonlyArray<string>,
): Effect.Effect<void, OmoAgentSettingsWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* resolveOmoCodingAgentDir(environment);
    const settingsPath = path.join(dir, OMO_SETTINGS_FILE);
    const writeError = (operation: string) => (cause: unknown) =>
      new OmoAgentSettingsWriteError({ settingsPath, operation, cause });

    const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
    let parsed: Readonly<Record<string, unknown>> = {};
    if (Option.isSome(raw)) {
      const json = decodeJson(raw.value);
      const object = Result.isFailure(json) ? json : decodeSettingsObject(json.success);
      if (Result.isFailure(object)) {
        return yield* new OmoAgentSettingsWriteError({
          settingsPath,
          operation: "parse-settings",
          cause: object.failure,
        });
      }
      parsed = object.success;
    }

    const next = { ...parsed };
    if (favoriteModels.length === 0) {
      delete next.favoriteModels;
    } else {
      next.favoriteModels = [...favoriteModels];
    }

    const stamp = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const tmpPath = `${settingsPath}.${stamp}.tmp`;
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(writeError("make-directory")));
    const serialized = encodeSettingsObject(next);
    if (Result.isFailure(serialized)) {
      return yield* new OmoAgentSettingsWriteError({
        settingsPath,
        operation: "serialize-settings",
        cause: serialized.failure,
      });
    }
    yield* fs
      .writeFileString(tmpPath, serialized.success)
      .pipe(Effect.mapError(writeError("write-temp-file")));
    yield* fs.rename(tmpPath, settingsPath).pipe(Effect.mapError(writeError("rename")));
  });

/**
 * Atomically remembers one model's thinking level in senpi's shared maps.
 * Non-off selections also refresh the last-on map; off deliberately preserves
 * its previous entry. Unknown top-level settings and other model entries are
 * retained, and equal writes are skipped to avoid watcher mirror loops.
 */
type OmoModelThinkingLevelWriteHooks = {
  readonly beforeLock?: () => Effect.Effect<void>;
  readonly acquireLock?: (settingsPath: string) => () => void;
  readonly beforeRename?: () => void;
};

const FILE_STORAGE_LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  update: 10_000,
} as const;

const acquireSettingsLockSyncWithRetry = (settingsPath: string): (() => void) => {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return lockfile.lockSync(settingsPath, FILE_STORAGE_LOCK_OPTIONS);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { readonly code?: unknown }).code)
          : undefined;
      if (code !== "ELOCKED" || attempt === 10) throw error;
      lastError = error;
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  throw lastError;
};

export const writeOmoModelThinkingLevel = (
  environment: NodeJS.ProcessEnv,
  provider: string,
  modelId: string,
  level: OmoThinkingLevel,
  hooks: OmoModelThinkingLevelWriteHooks = {},
): Effect.Effect<void, OmoAgentSettingsWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* resolveOmoCodingAgentDir(environment);
    const settingsPath = path.join(dir, OMO_SETTINGS_FILE);
    const writeError = (operation: string) => (cause: unknown) =>
      new OmoAgentSettingsWriteError({ settingsPath, operation, cause });
    const decodeCurrent = (
      raw: string,
    ): Effect.Effect<Readonly<Record<string, unknown>>, OmoAgentSettingsWriteError> => {
      const json = decodeJson(raw);
      const object = Result.isFailure(json) ? json : decodeSettingsObject(json.success);
      return Result.isFailure(object)
        ? Effect.fail(
            new OmoAgentSettingsWriteError({
              settingsPath,
              operation: "parse-settings",
              cause: object.failure,
            }),
          )
        : Effect.succeed(object.success);
    };
    const mergeLevel = (parsed: Readonly<Record<string, unknown>>) => {
      const modelKey = `${provider}/${modelId}`;
      const currentLevels: Readonly<Record<string, unknown>> =
        typeof parsed.modelThinkingLevels === "object" &&
        parsed.modelThinkingLevels !== null &&
        !Array.isArray(parsed.modelThinkingLevels)
          ? (parsed.modelThinkingLevels as Readonly<Record<string, unknown>>)
          : {};
      const lastOnLevels: Readonly<Record<string, unknown>> =
        typeof parsed.modelLastOnThinkingLevels === "object" &&
        parsed.modelLastOnThinkingLevels !== null &&
        !Array.isArray(parsed.modelLastOnThinkingLevels)
          ? (parsed.modelLastOnThinkingLevels as Readonly<Record<string, unknown>>)
          : {};
      const complete =
        currentLevels[modelKey] === level && (level === "off" || lastOnLevels[modelKey] === level);
      if (complete) return undefined;
      return {
        ...parsed,
        modelThinkingLevels: { ...currentLevels, [modelKey]: level },
        ...(level === "off"
          ? {}
          : { modelLastOnThinkingLevels: { ...lastOnLevels, [modelKey]: level } }),
      };
    };

    const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
    if (Option.isNone(raw)) {
      return yield* new OmoAgentSettingsWriteError({
        settingsPath,
        operation: "read-settings",
        cause: "settings file is missing or unreadable",
      });
    }
    const parsed = yield* decodeCurrent(raw.value);
    if (mergeLevel(parsed) === undefined) return;

    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(writeError("make-directory")));
    yield* hooks.beforeLock?.() ?? Effect.void;
    yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => (hooks.acquireLock ?? acquireSettingsLockSyncWithRetry)(settingsPath),
        catch: writeError("acquire-lock"),
      }),
      () =>
        Effect.gen(function* () {
          const underLockRaw = yield* fs
            .readFileString(settingsPath)
            .pipe(Effect.mapError(writeError("read-settings-under-lock")));
          const underLock = yield* decodeCurrent(underLockRaw);
          const next = mergeLevel(underLock);
          if (next === undefined) return;

          const serialized = encodeSettingsObject(next);
          if (Result.isFailure(serialized)) {
            return yield* new OmoAgentSettingsWriteError({
              settingsPath,
              operation: "serialize-settings",
              cause: serialized.failure,
            });
          }
          const tmpPath = `${settingsPath}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
          yield* Effect.gen(function* () {
            yield* fs
              .writeFileString(tmpPath, serialized.success)
              .pipe(Effect.mapError(writeError("write-temp-file")));
            yield* Effect.try({
              try: () => hooks.beforeRename?.(),
              catch: writeError("rename"),
            });
            yield* fs.rename(tmpPath, settingsPath).pipe(Effect.mapError(writeError("rename")));
          }).pipe(Effect.ensuring(fs.remove(tmpPath).pipe(Effect.ignore)));
        }),
      (release) => Effect.try({ try: release, catch: writeError("release-lock") }),
    );
  });

/**
 * Atomically rewrites the `defaultProvider`/`defaultModel` pair in
 * `<dir>/settings.json` (tmp-file + rename, matching omo's own two-space
 * formatting), preserving every other key. Unlike `writeOmoFavoriteModels`
 * this never creates the file — omo owns first-run creation, so a missing
 * or unreadable settings file fails with `OmoAgentSettingsWriteError`, and
 * a corrupt file is never clobbered. When the file already holds the same
 * pair the write is skipped entirely, keeping the settings watcher quiet.
 */
export const writeOmoDefaultModel = (
  environment: NodeJS.ProcessEnv,
  ref: OmoModelRef,
): Effect.Effect<void, OmoAgentSettingsWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* resolveOmoCodingAgentDir(environment);
    const settingsPath = path.join(dir, OMO_SETTINGS_FILE);
    const writeError = (operation: string) => (cause: unknown) =>
      new OmoAgentSettingsWriteError({ settingsPath, operation, cause });

    const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
    if (Option.isNone(raw)) {
      return yield* new OmoAgentSettingsWriteError({
        settingsPath,
        operation: "read-settings",
        cause: "settings file is missing or unreadable",
      });
    }

    const json = decodeJson(raw.value);
    const object = Result.isFailure(json) ? json : decodeSettingsObject(json.success);
    if (Result.isFailure(object)) {
      return yield* new OmoAgentSettingsWriteError({
        settingsPath,
        operation: "parse-settings",
        cause: object.failure,
      });
    }
    const parsed = object.success;

    if (parsed.defaultProvider === ref.provider && parsed.defaultModel === ref.modelId) {
      return;
    }

    const next = { ...parsed, defaultProvider: ref.provider, defaultModel: ref.modelId };

    const stamp = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const tmpPath = `${settingsPath}.${stamp}.tmp`;
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(writeError("make-directory")));
    const serialized = encodeSettingsObject(next);
    if (Result.isFailure(serialized)) {
      return yield* new OmoAgentSettingsWriteError({
        settingsPath,
        operation: "serialize-settings",
        cause: serialized.failure,
      });
    }
    yield* fs
      .writeFileString(tmpPath, serialized.success)
      .pipe(Effect.mapError(writeError("write-temp-file")));
    yield* fs.rename(tmpPath, settingsPath).pipe(Effect.mapError(writeError("rename")));
  });
