/**
 * Location resolution and contract-error mapping for the agent-config RPCs.
 *
 * The IO module (`omoAgentConfigIo`) is location-agnostic; this module binds
 * it to the running server: the agent dir comes from the omo instance
 * environment (`OMO_CODING_AGENT_DIR`, else `~/.omo/agent`) and the project
 * dir from the primary environment's working directory. The USER omo config
 * layer mirrors omo-config-core's `detectUserOmoJsonPath`: `~/.omo/omo.jsonc`
 * when it exists, else `~/.omo/omo.json` when only that exists, else
 * `~/.omo/omo.jsonc` as the path a first write creates.
 *
 * @module provider/omo/omoAgentConfigService
 */
import * as NodeOS from "node:os";

import {
  AgentConfigReadError,
  type AgentConfigReadInput,
  type AgentConfigReadResult,
  AgentConfigWriteError,
  type AgentConfigWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readAgentConfigFile,
  writeAgentConfigFile,
  type AgentConfigLocations,
} from "./omoAgentConfigIo.ts";
import { resolveOmoCodingAgentDir } from "./omoAgentSettings.ts";
import { resolveOmoModelRouting } from "./omoModelRouting.ts";

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

const resolveUserOmoConfigPath = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const home =
      nonEmpty(environment.HOME) ?? nonEmpty(environment.USERPROFILE) ?? NodeOS.homedir();
    const configDir = path.join(home, ".omo");
    const jsoncPath = path.join(configDir, "omo.jsonc");
    const exists = (candidate: string): Effect.Effect<boolean> =>
      fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (yield* exists(jsoncPath)) return jsoncPath;
    const jsonPath = path.join(configDir, "omo.json");
    return (yield* exists(jsonPath)) ? jsonPath : jsoncPath;
  });

export const resolveAgentConfigLocations = (
  environment: NodeJS.ProcessEnv,
  projectDir: string,
): Effect.Effect<AgentConfigLocations, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const agentDir = yield* resolveOmoCodingAgentDir(environment);
    return {
      agentDir,
      projectDir,
      omoConfigPath: path.join(projectDir, ".omo", "omo.jsonc"),
      omoConfigUserPath: yield* resolveUserOmoConfigPath(environment),
    };
  });

export const readAgentConfig = (
  environment: NodeJS.ProcessEnv,
  projectDir: string,
  input: AgentConfigReadInput,
): Effect.Effect<AgentConfigReadResult, AgentConfigReadError, FileSystem.FileSystem | Path.Path> =>
  resolveAgentConfigLocations(environment, projectDir).pipe(
    Effect.flatMap((locations) => readAgentConfigFile({ ...locations, file: input.file })),
    Effect.map((result) =>
      (input.file === "omoConfig" || input.file === "omoConfigUser") &&
      input.availableModels !== undefined
        ? {
            ...result,
            payload: {
              ...result.payload,
              routing: resolveOmoModelRouting(result.payload.values ?? {}, input.availableModels),
            },
          }
        : result,
    ),
    Effect.catchDefect((defect) =>
      Effect.fail(
        new AgentConfigReadError({
          file: input.file,
          reason: "unreadable",
          detail: String(defect),
        }),
      ),
    ),
  );

export const writeAgentConfig = (
  environment: NodeJS.ProcessEnv,
  projectDir: string,
  input: AgentConfigWriteInput,
): Effect.Effect<AgentConfigReadResult, AgentConfigWriteError, FileSystem.FileSystem | Path.Path> =>
  resolveAgentConfigLocations(environment, projectDir).pipe(
    Effect.flatMap((locations) =>
      "edits" in input
        ? writeAgentConfigFile({ ...locations, file: input.file, edits: input.edits })
        : writeAgentConfigFile({ ...locations, file: input.file, values: input.values }),
    ),
    Effect.catchDefect((defect) =>
      Effect.fail(
        new AgentConfigWriteError({
          file: input.file,
          reason: "write_failed",
          detail: String(defect),
        }),
      ),
    ),
  );
