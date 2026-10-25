/**
 * Agent configuration file surfaces: omo's `settings.json`, omo's project
 * and user `omo.jsonc`, and the global/project `mcp.json` files.
 *
 * `omoConfig` is the PROJECT layer (`<projectDir>/.omo/omo.jsonc`) and
 * `omoConfigUser` the USER layer (`~/.omo/omo.jsonc`); omo merges both, so
 * each is addressable on its own here instead of being flattened.
 *
 * Every payload keeps unknown keys so the contract survives omo/omo schema
 * growth, and a malformed file degrades to `parseError` + empty values instead
 * of failing the read. `${ENV_VAR}` references inside MCP server entries are
 * relayed verbatim: nothing in this contract resolves or expands them.
 *
 * @module agentConfig
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OmoModelRoutingRow } from "./omoModelRouting.ts";

export const AGENT_CONFIG_FILE_IDS = [
  "omoAgentSettings",
  "omoConfig",
  "omoConfigUser",
  "mcpGlobal",
  "mcpProject",
] as const;

export const AGENT_CONFIG_WRITABLE_FILE_IDS = [
  "omoAgentSettings",
  "omoConfig",
  "omoConfigUser",
  "mcpGlobal",
  "mcpProject",
] as const;

/** The omo config file ids, one per merge layer omo reads. */
export const AGENT_CONFIG_OMO_FILE_IDS = ["omoConfig", "omoConfigUser"] as const;

export const AgentConfigOmoFileId = Schema.Literals(AGENT_CONFIG_OMO_FILE_IDS);
export type AgentConfigOmoFileId = typeof AgentConfigOmoFileId.Type;

export const AgentConfigFileId = Schema.Literals(AGENT_CONFIG_FILE_IDS);
export type AgentConfigFileId = typeof AgentConfigFileId.Type;

export const AgentConfigWritableFileId = Schema.Literals(AGENT_CONFIG_WRITABLE_FILE_IDS);
export type AgentConfigWritableFileId = typeof AgentConfigWritableFileId.Type;

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const AgentConfigFileBase = {
  path: TrimmedNonEmptyString,
  exists: Schema.Boolean,
  parseError: Schema.NullOr(Schema.String),
};

export const AgentConfigOmoAgentSettingsFile = Schema.Struct({
  ...AgentConfigFileBase,
  values: UnknownRecord,
});
export type AgentConfigOmoAgentSettingsFile = typeof AgentConfigOmoAgentSettingsFile.Type;

export const AgentConfigOmoFile = Schema.Struct({
  ...AgentConfigFileBase,
  text: Schema.String,
  values: Schema.optionalKey(UnknownRecord),
});
export type AgentConfigOmoFile = typeof AgentConfigOmoFile.Type;

/**
 * Known field names of omo's MCP `ServerSchema` (builtin/mcp
 * `config-schema.ts`), for editors that want to render a typed form. Server
 * entries themselves stay open records so an entry written by a newer omo
 * round-trips through T3 untouched.
 */
export const AGENT_CONFIG_MCP_SERVER_FIELDS = [
  "type",
  "url",
  "command",
  "args",
  "env",
  "cwd",
  "headers",
  "auth",
  "bearerTokenEnv",
  "oauth",
  "enabled",
  "lifecycle",
  "idleTimeoutMin",
  "requestTimeoutMs",
  "connectTimeoutMs",
  "startupTimeoutMs",
  "includeTools",
  "excludeTools",
  "directTools",
  "exposure",
  "logLevel",
] as const;
export type AgentConfigMcpServerField = (typeof AGENT_CONFIG_MCP_SERVER_FIELDS)[number];

export const AgentConfigMcpServer = UnknownRecord;
export type AgentConfigMcpServer = typeof AgentConfigMcpServer.Type;

export const AgentConfigMcpFile = Schema.Struct({
  ...AgentConfigFileBase,
  settings: UnknownRecord,
  mcpServers: Schema.Record(Schema.String, UnknownRecord),
});
export type AgentConfigMcpFile = typeof AgentConfigMcpFile.Type;

export const AgentConfigReadInput = Schema.Struct({
  file: AgentConfigFileId,
  availableModels: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type AgentConfigReadInput = typeof AgentConfigReadInput.Type;

export const AgentConfigOmoAgentSettingsRead = Schema.Struct({
  file: Schema.Literal("omoAgentSettings"),
  payload: AgentConfigOmoAgentSettingsFile,
});

export const AgentConfigOmoRead = Schema.Struct({
  file: AgentConfigOmoFileId,
  payload: AgentConfigOmoFile,
});

export const AgentConfigMcpGlobalRead = Schema.Struct({
  file: Schema.Literal("mcpGlobal"),
  payload: AgentConfigMcpFile,
});

export const AgentConfigMcpProjectRead = Schema.Struct({
  file: Schema.Literal("mcpProject"),
  payload: AgentConfigMcpFile,
});

export const AgentConfigReadResult = Schema.Struct({
  file: AgentConfigFileId,
  payload: Schema.Struct({
    ...AgentConfigFileBase,
    values: Schema.optional(UnknownRecord),
    text: Schema.optional(Schema.String),
    mcpServers: Schema.optional(Schema.Record(Schema.String, UnknownRecord)),
    settings: Schema.optional(UnknownRecord),
    routing: Schema.optional(Schema.Array(OmoModelRoutingRow)),
  }),
});
export type AgentConfigReadResult = typeof AgentConfigReadResult.Type;

const AgentConfigRecordWriteInput = Schema.Struct({
  file: Schema.Literals(["omoAgentSettings", "mcpGlobal", "mcpProject"]),
  values: UnknownRecord,
});

export const AgentConfigOmoEdit = Schema.Struct({
  path: Schema.NonEmptyArray(TrimmedNonEmptyString),
  /** `null` removes the property at `path`; other values replace or create it. */
  value: Schema.NullOr(Schema.Unknown),
});
export type AgentConfigOmoEdit = typeof AgentConfigOmoEdit.Type;

export const AgentConfigWriteInput = Schema.Union([
  AgentConfigRecordWriteInput,
  Schema.Struct({
    file: AgentConfigOmoFileId,
    edits: Schema.Array(AgentConfigOmoEdit),
  }),
]);
export type AgentConfigWriteInput = typeof AgentConfigWriteInput.Type;

export class AgentConfigReadError extends Schema.TaggedError<AgentConfigReadError>()(
  "AgentConfigReadError",
  {
    file: AgentConfigFileId,
    reason: Schema.Literals(["unavailable", "unreadable"]),
    detail: Schema.String,
  },
) {}

export class AgentConfigWriteError extends Schema.TaggedError<AgentConfigWriteError>()(
  "AgentConfigWriteError",
  {
    file: AgentConfigWritableFileId,
    reason: Schema.Literals(["parse_failed", "write_failed", "unavailable"]),
    detail: Schema.String,
  },
) {}
