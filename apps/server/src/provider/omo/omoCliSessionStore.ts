/**
 * Canonical locator for the omo native CLI's session store.
 *
 * Every value here mirrors a resolution the senpi engine performs, so the
 * desktop app looks in the directory the CLI actually writes. Diverging by one
 * step presents to the user as "my sessions are gone".
 *
 * The chain, in order, verified against the engine:
 *
 * 1. `$OMO_/SENPI_/PI_CODING_AGENT_SESSION_DIR` — `config.js:434` derives
 *    `ENV_SESSION_DIR` from the brand prefix and `core/brand.js:126-141` reads
 *    it across the brand prefix plus the legacy `SENPI`/`PI` prefixes;
 *    `main.js:646-650` consults it before settings.
 * 2. `sessionDir` from `<agentDir>/settings.json` —
 *    `core/settings-manager.js:706-709` (`getSessionDir()` returns the
 *    normalized `settings.sessionDir`), reached via
 *    `startupSettingsManager.getSessionDir()` at `main.js:650`.
 * 3. `join(agentDir, "sessions")` — `config.js:496-498` (`getSessionsDir`),
 *    where `agentDir` follows `config.js:446-467` (`resolveAgentDir`): an
 *    explicit `*_CODING_AGENT_DIR`, else the nearest ancestor of the cwd that
 *    holds a `.omo` directory containing `agent`
 *    (`nearest-parent-config.js:findNearestParentConfigDir`, home excluded),
 *    else `join(home, ".omo", "agent")`. The omo brand ships
 *    `configDir: ".omo"` with `flatLayout: false`, so the non-flat branch is
 *    the one that applies.
 *
 * The legacy locations `~/.omo/sessions` and `~/.omo/sessions.pre-omo-link-*`
 * are NEVER returned and never unioned in. They are pre-unification leftovers
 * the CLI no longer writes; reading them would resurrect sessions the user's
 * own migration already moved on from.
 *
 * @module provider/omo/omoCliSessionStore
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { nonEmptyTrimmed } from "./omoAgentSettings.ts";

/** Env names carrying an explicit session directory, most specific first. */
const CODING_AGENT_SESSION_DIR_ENV_NAMES = [
  "OMO_CODING_AGENT_SESSION_DIR",
  "SENPI_CODING_AGENT_SESSION_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
] as const;

const OMO_CONFIG_DIR_NAME = ".omo";
const OMO_AGENT_DIR_NAME = "agent";
const OMO_SESSIONS_DIR_NAME = "sessions";
const OMO_SETTINGS_FILE = "settings.json";

/** Matches senpi's `MAX_PARENT_CONFIG_SEARCH_DEPTH` (`nearest-parent-config.js`). */
const MAX_PARENT_SEARCH_DEPTH = 100;

/**
 * Only `sessionDir` is read, and leniently: a settings file omo owns may hold
 * anything, and a malformed or wrongly-typed value must degrade to the next
 * step in the chain rather than break session discovery.
 */
const SessionDirSettings = Schema.Struct({
  sessionDir: Schema.optional(Schema.String),
});

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeSessionDirSettings = Schema.decodeUnknownResult(SessionDirSettings);

/**
 * The omo agent directory, mirroring `resolveAgentDir` (`config.js:446-467`).
 *
 * `homeOverride` exists so tests can resolve against a fixture home; production
 * callers pass nothing and get `os.homedir()`, exactly like the engine.
 */
const resolveAgentDir = (
  environment: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;

    for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
      const override = nonEmptyTrimmed(environment[name]);
      if (override !== undefined) return path.resolve(override);
    }

    const home = nonEmptyTrimmed(environment.HOME) ?? NodeOS.homedir();
    const start = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => path.resolve(workspaceRoot)));
    const normalizedHome = path.resolve(home);

    // Home is excluded so its config stays the global fallback layer, and the
    // `agent` child is required so an unrelated `.omo` directory (boulder
    // state, task artifacts) is not mistaken for agent config.
    let current = start;
    for (let depth = 0; depth <= MAX_PARENT_SEARCH_DEPTH; depth += 1) {
      if (current === normalizedHome) break;
      const configDir = path.join(current, OMO_CONFIG_DIR_NAME);
      const agentDir = path.join(configDir, OMO_AGENT_DIR_NAME);
      const isAgentDir = yield* fs.stat(agentDir).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isAgentDir) return agentDir;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }

    return path.join(normalizedHome, OMO_CONFIG_DIR_NAME, OMO_AGENT_DIR_NAME);
  });

/** `sessionDir` from `<agentDir>/settings.json`, or none if it is absent or unusable. */
const readSettingsSessionDir = (
  agentDir: string,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs
      .readFileString(path.join(agentDir, OMO_SETTINGS_FILE))
      .pipe(Effect.option);
    if (Option.isNone(raw)) return Option.none();

    const json = decodeJson(raw.value);
    if (Result.isFailure(json)) return Option.none();

    const decoded = decodeSessionDirSettings(json.success);
    if (Result.isFailure(decoded)) return Option.none();

    return Option.fromNullishOr(nonEmptyTrimmed(decoded.success.sessionDir));
  });

/**
 * The directory holding the CLI's per-workspace session directories.
 *
 * `environment` is injected rather than read from `process.env` so callers can
 * resolve for a specific provider instance, and tests can pin the whole chain.
 */
export const resolveCliSessionsRoot = (
  environment: Readonly<Record<string, string | undefined>>,
  workspaceRoot: string,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    for (const name of CODING_AGENT_SESSION_DIR_ENV_NAMES) {
      const override = nonEmptyTrimmed(environment[name]);
      if (override !== undefined) return override;
    }

    const agentDir = yield* resolveAgentDir(environment, workspaceRoot);
    const configured = yield* readSettingsSessionDir(agentDir);
    if (Option.isSome(configured)) return configured.value;

    return path.join(agentDir, OMO_SESSIONS_DIR_NAME);
  });

/**
 * Encode a cwd the way senpi names its per-workspace session directory:
 * `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 * (`core/session-manager.js:317-322`).
 *
 * This encoding is LOSSY and NON-INVERTIBLE: `/a/b`, `/a:b` and `/a-b` all
 * encode to `--a-b--`, and a leading separator is stripped outright. It is only
 * ever a candidate PREFILTER for narrowing which directories to open — never an
 * identity, never a way to recover a path. The authoritative answer to "which
 * workspace does this session belong to" is the `cwd` field in each file's
 * header.
 */
export const encodeCwdDir = (cwd: string): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const resolved = path.resolve(cwd);
    const safe = resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
    return `--${safe}--`;
  });

/**
 * Predicate over session-directory NAMES for one workspace root: the exact
 * encoding of the root, plus every encoding that continues past it with a
 * separator (a descendant, e.g. a package inside the repo).
 *
 * It over-matches on purpose — `--repo-2--` is a descendant `<root>/2` as far
 * as the encoding can tell, and `--repo-src--` could equally be a sibling
 * directory literally named `repo-src`. A later stage confirms each candidate
 * against the `cwd` recorded in the file's own header, so a false positive
 * costs one file open and never a wrong adoption.
 */
export const candidateDirsForWorkspaceRoot = (
  workspaceRoot: string,
): Effect.Effect<(directoryName: string) => boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs
      .realPath(workspaceRoot)
      .pipe(Effect.orElseSucceed(() => path.resolve(workspaceRoot)));
    const exact = yield* encodeCwdDir(real);
    const descendantPrefix = `${exact.slice(0, exact.length - "--".length)}-`;
    return (directoryName: string): boolean =>
      directoryName === exact || directoryName.startsWith(descendantPrefix);
  });
