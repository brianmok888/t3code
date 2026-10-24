/**
 * OmoSkillDiscovery — populates the provider snapshot's `skills` (the `$`
 * picker) from omo's own command registry.
 *
 * The RPC is authoritative: omo composes user, project, and plugin skills
 * itself, so T3 never scans the filesystem for them. Multi-session RPC has no
 * session-less commands, so discovery runs through an ephemeral control
 * session on the shared process (open_session → get_commands +
 * get_loaded_surfaces → close_session), mirroring the model-discovery flow. The session is opened
 * with the environment cwd so project-scoped skills resolve against the
 * project the server was started in.
 *
 * Unlike models, runtime inventory is best-effort enrichment. Skill and loaded
 * surface requests degrade independently after the session opens, while an
 * open-session failure degrades every list; no inventory failure can take an
 * otherwise-ready provider down. The
 * snapshot caches the result until the next probe — the same cadence as model
 * discovery — so threads never issue per-thread `get_commands` traffic.
 *
 * @module provider/Layers/OmoSkillDiscovery
 */
import {
  type ServerProviderMcpServer,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { nonEmptyTrimmed } from "../providerSnapshot.ts";
import { type OmoSharedProcess } from "../omo/omoRpcConnection.ts";
import {
  OmoGetCommandsData,
  OmoGetLoadedSurfacesData,
  type OmoLoadedExtension,
  type OmoLoadedMcpServer,
  type OmoSlashCommand,
} from "../omo/omoRpcProtocol.ts";
import { acquireOmoControlSession } from "./OmoModelDiscovery.ts";

const decodeGetCommandsData = Schema.decodeUnknownResult(OmoGetCommandsData);
const decodeLoadedSurfacesData = Schema.decodeUnknownResult(OmoGetLoadedSurfacesData);

const NO_SKILLS: ReadonlyArray<ServerProviderSkill> = [];
const NO_SLASH_COMMANDS: ReadonlyArray<ServerProviderSlashCommand> = [];
const NO_MCP_SERVERS: ReadonlyArray<ServerProviderMcpServer> = [];

export type OmoCommandSurfaces = {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly extensions: ReadonlyArray<ServerProviderSkill>;
  readonly mcpServers: ReadonlyArray<ServerProviderMcpServer>;
};
export const NO_SURFACES: OmoCommandSurfaces = {
  skills: NO_SKILLS,
  slashCommands: NO_SLASH_COMMANDS,
  extensions: NO_SKILLS,
  mcpServers: NO_MCP_SERVERS,
};

/**
 * Maps decoded `get_commands` rows to snapshot skills. Only `source: "skill"`
 * rows become skills; extension command rows are deliberately ignored because
 * the loaded-extension inventory is authoritative for that surface.
 */
export const skillsFromSlashCommands = (
  commands: ReadonlyArray<OmoSlashCommand>,
): ReadonlyArray<ServerProviderSkill> => {
  const skills: ServerProviderSkill[] = [];
  for (const command of commands) {
    if (command.source !== "skill") continue;
    const name = nonEmptyTrimmed(command.name);
    const path = nonEmptyTrimmed(command.sourceInfo.path);
    if (name === undefined || path === undefined) continue;
    const description = nonEmptyTrimmed(command.description);
    const scope = nonEmptyTrimmed(command.sourceInfo.scope);
    skills.push({
      name,
      path,
      enabled: true,
      ...(description === undefined ? {} : { description }),
      ...(scope === undefined ? {} : { scope }),
    });
  }
  return skills;
};

/** Maps prompt and extension rows to the provider's existing slash-command surface. */
export const providerSlashCommandsFromRpcCommands = (
  commands: ReadonlyArray<OmoSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> => {
  const slashCommands: ServerProviderSlashCommand[] = [];
  for (const command of commands) {
    if (command.source === "skill") continue;
    const name = nonEmptyTrimmed(command.name);
    if (name === undefined) continue;
    const description = nonEmptyTrimmed(command.description);
    slashCommands.push({
      name,
      ...(description === undefined ? {} : { description }),
    });
  }
  return slashCommands;
};

export const extensionsFromLoadedInventory = (
  loaded: ReadonlyArray<OmoLoadedExtension>,
): ReadonlyArray<ServerProviderSkill> => {
  const extensions: ServerProviderSkill[] = [];
  for (const extension of loaded) {
    const name = nonEmptyTrimmed(extension.name);
    const path = nonEmptyTrimmed(extension.path);
    if (name === undefined || path === undefined) continue;
    const scope = nonEmptyTrimmed(extension.sourceInfo.scope);
    extensions.push({
      name,
      path,
      enabled: extension.enabled,
      ...(scope === undefined ? {} : { scope }),
    });
  }
  return extensions;
};

export const mcpServersFromLoadedInventory = (
  loaded: ReadonlyArray<OmoLoadedMcpServer>,
): ReadonlyArray<ServerProviderMcpServer> => {
  const servers: ServerProviderMcpServer[] = [];
  for (const server of loaded) {
    const name = nonEmptyTrimmed(server.name);
    if (name === undefined || !Number.isSafeInteger(server.toolCount) || server.toolCount < 0)
      continue;
    servers.push({ name, toolCount: server.toolCount, status: server.status });
  }
  return servers;
};

/** Discover best-effort runtime surfaces through an already-open control session. */
export const discoverSkillsInSession = (
  shared: OmoSharedProcess,
  routingHandle: string,
): Effect.Effect<OmoCommandSurfaces> =>
  Effect.gen(function* () {
    const commands = yield* shared
      .request({ type: "get_commands", sessionId: routingHandle }, "control")
      .pipe(Effect.result);
    const loaded = yield* shared
      .request({ type: "get_loaded_surfaces", sessionId: routingHandle }, "control")
      .pipe(Effect.result);

    let skills = NO_SKILLS;
    let slashCommands = NO_SLASH_COMMANDS;
    if (Result.isFailure(commands)) {
      yield* Effect.logWarning(
        `omo get_commands failed; snapshot skills degraded to []: ${String(commands.failure)}`,
      );
    } else {
      const decoded = decodeGetCommandsData(commands.success.data);
      if (Result.isFailure(decoded)) {
        yield* Effect.logWarning(
          `omo get_commands payload failed to decode; snapshot skills degraded to []: ${String(decoded.failure)}`,
        );
      } else {
        skills = skillsFromSlashCommands(decoded.success.commands);
        slashCommands = providerSlashCommandsFromRpcCommands(decoded.success.commands);
      }
    }

    if (Result.isFailure(loaded)) {
      yield* Effect.logWarning(
        `omo get_loaded_surfaces failed; runtime inventory degraded to []: ${String(loaded.failure)}`,
      );
      return { skills, slashCommands, extensions: NO_SKILLS, mcpServers: NO_MCP_SERVERS };
    }
    const decodedLoaded = decodeLoadedSurfacesData(loaded.success.data);
    if (Result.isFailure(decodedLoaded)) {
      yield* Effect.logWarning(
        `omo get_loaded_surfaces payload failed to decode; runtime inventory degraded to []: ${String(decodedLoaded.failure)}`,
      );
      return { skills, slashCommands, extensions: NO_SKILLS, mcpServers: NO_MCP_SERVERS };
    }
    return {
      skills,
      slashCommands,
      extensions: extensionsFromLoadedInventory(decodedLoaded.success.extensions),
      mcpServers: mcpServersFromLoadedInventory(decodedLoaded.success.mcpServers),
    };
  });

/**
 * Runs skill discovery through the shared process using a temporary control
 * session: open_session (no sessionPath — ephemeral, no persistence) →
 * get_commands + get_loaded_surfaces → close_session. Never fails: request
 * and decode errors log a warning and degrade only the affected inventory.
 */
export const discoverSkillsViaSharedProcess = (
  shared: OmoSharedProcess,
  options: { readonly cwd: string },
): Effect.Effect<OmoCommandSurfaces, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const routingHandle = yield* acquireOmoControlSession(shared, { cwd: options.cwd });
      return yield* discoverSkillsInSession(shared, routingHandle);
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `omo skill discovery failed; snapshot skills degraded to []: ${String(error)}`,
      ).pipe(Effect.as(NO_SURFACES)),
    ),
  );
