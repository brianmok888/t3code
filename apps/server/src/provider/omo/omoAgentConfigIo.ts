/**
 * Read/merge/write IO for the agent configuration files T3 surfaces:
 * omo's `<agentDir>/settings.json`, omo's project and user `omo.jsonc`, and
 * the global `<agentDir>/mcp.json` / project `<projectDir>/.omo/mcp.json`
 * files. The two omo layers share one read-merge-write path and differ only
 * in which file they resolve to.
 *
 * Reads are lenient — a missing file yields `exists: false` and a malformed
 * one yields `parseError` with empty values, never a failure — so a broken
 * config never takes the settings UI down. Writes are read-merge-write with
 * atomic tmp+rename, preserve every unknown key, and refuse to clobber a file
 * they could not parse. Nothing here resolves `${ENV_VAR}` references.
 *
 * Endpoint registration lives in the server RPC registry, not in this module.
 *
 * @module provider/omo/omoAgentConfigIo
 */
import * as NodeOS from "node:os";

import {
  AgentConfigWriteError,
  type AgentConfigFileId,
  type AgentConfigMcpFile,
  type AgentConfigOmoEdit,
  type AgentConfigOmoFile,
  type AgentConfigReadResult,
  type AgentConfigOmoAgentSettingsFile,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { applyOmoConfigEdits, parseOmoConfig } from "./omoJsonc.ts";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeRecord = Schema.decodeUnknownResult(UnknownRecord);
const encodeRecord = Schema.encodeUnknownResult(fromJsonStringPretty(UnknownRecord));

export interface AgentConfigLocations {
  readonly agentDir: string;
  readonly projectDir: string;
  readonly omoConfigPath?: string;
  /** Resolved by the service from the home dir; see `resolveAgentConfigLocations`. */
  readonly omoConfigUserPath?: string;
}

export interface AgentConfigReadRequest extends AgentConfigLocations {
  readonly file: AgentConfigFileId;
}

export type AgentConfigWriteRequest = AgentConfigLocations &
  (
    | {
        readonly file: "omoAgentSettings" | "mcpGlobal" | "mcpProject";
        readonly values: Readonly<Record<string, unknown>>;
      }
    | {
        readonly file: "omoConfig" | "omoConfigUser";
        readonly edits: ReadonlyArray<AgentConfigOmoEdit>;
      }
  );

type AgentConfigOmoWriteRequest = Extract<AgentConfigWriteRequest, { readonly edits: unknown }>;

const isOmoConfigWrite = (
  request: AgentConfigWriteRequest,
): request is AgentConfigOmoWriteRequest =>
  request.file === "omoConfig" || request.file === "omoConfigUser";

export const resolveAgentConfigPath = (
  request: AgentConfigReadRequest,
): Effect.Effect<string, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    switch (request.file) {
      case "omoAgentSettings":
        return path.join(request.agentDir, "settings.json");
      case "omoConfig":
        return request.omoConfigPath ?? path.join(request.projectDir, ".omo", "omo.jsonc");
      case "omoConfigUser":
        return request.omoConfigUserPath ?? path.join(NodeOS.homedir(), ".omo", "omo.jsonc");
      case "mcpGlobal":
        return path.join(request.agentDir, "mcp.json");
      case "mcpProject":
        return path.join(request.projectDir, ".omo", "mcp.json");
    }
  });

interface RawFile {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string;
}

const readRawFile = (filePath: string): Effect.Effect<RawFile, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
    return Option.isNone(raw)
      ? { path: filePath, exists: false, text: "" }
      : { path: filePath, exists: true, text: raw.value };
  });

const parseRecord = (
  raw: RawFile,
): { readonly values: Record<string, unknown>; readonly parseError: string | null } => {
  if (!raw.exists || raw.text.trim().length === 0) return { values: {}, parseError: null };
  const json = decodeJson(raw.text);
  const record = Result.isFailure(json) ? json : decodeRecord(json.success);
  if (Result.isFailure(record)) return { values: {}, parseError: String(record.failure) };
  return { values: { ...record.success }, parseError: null };
};

const omoSettingsPayload = (raw: RawFile): AgentConfigOmoAgentSettingsFile => {
  const parsed = parseRecord(raw);
  return {
    path: raw.path,
    exists: raw.exists,
    parseError: parsed.parseError,
    values: parsed.values,
  };
};

const omoPayload = (raw: RawFile): AgentConfigOmoFile => {
  const parsed = parseOmoConfig(raw.text);
  return {
    path: raw.path,
    exists: raw.exists,
    parseError: parsed.parseError,
    text: raw.text,
    values: parsed.values,
  };
};

const mcpPayload = (raw: RawFile): AgentConfigMcpFile => {
  const parsed = parseRecord(raw);
  const settings = parsed.values.settings;
  const servers = parsed.values.mcpServers;
  const serverEntries =
    typeof servers === "object" && servers !== null && !Array.isArray(servers)
      ? Object.entries(servers as Record<string, unknown>)
      : [];
  return {
    path: raw.path,
    exists: raw.exists,
    parseError: parsed.parseError,
    settings:
      typeof settings === "object" && settings !== null && !Array.isArray(settings)
        ? { ...(settings as Record<string, unknown>) }
        : {},
    mcpServers: Object.fromEntries(
      serverEntries.flatMap(([name, entry]) =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? [[name, { ...(entry as Record<string, unknown>) }] as const]
          : [],
      ),
    ),
  };
};

export const readAgentConfigFile = (
  request: AgentConfigReadRequest,
): Effect.Effect<AgentConfigReadResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const filePath = yield* resolveAgentConfigPath(request);
    const raw = yield* readRawFile(filePath);
    switch (request.file) {
      case "omoAgentSettings":
        return { file: request.file, payload: omoSettingsPayload(raw) } as const;
      case "omoConfig":
      case "omoConfigUser":
        return { file: request.file, payload: omoPayload(raw) } as const;
      case "mcpGlobal":
      case "mcpProject":
        return { file: request.file, payload: mcpPayload(raw) } as const;
    }
  });

/** A `null` value removes its key; every other value replaces it. */
const mergeValues = (
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

export const writeAgentConfigFile = (
  request: AgentConfigWriteRequest,
): Effect.Effect<AgentConfigReadResult, AgentConfigWriteError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const filePath = yield* resolveAgentConfigPath(request);
    const writeError = (reason: "write_failed") => (cause: unknown) =>
      new AgentConfigWriteError({ file: request.file, reason, detail: String(cause) });

    const raw = yield* readRawFile(filePath);
    const parsed = isOmoConfigWrite(request) ? parseOmoConfig(raw.text) : parseRecord(raw);
    if (parsed.parseError !== null) {
      return yield* new AgentConfigWriteError({
        file: request.file,
        reason: "parse_failed",
        detail: parsed.parseError,
      });
    }
    const serialized = yield* Effect.gen(function* () {
      if (isOmoConfigWrite(request)) {
        const result = applyOmoConfigEdits(raw.text, request.edits);
        if (Result.isFailure(result)) {
          return yield* new AgentConfigWriteError({
            file: request.file,
            reason: "write_failed",
            detail: result.failure,
          });
        }
        return result.success;
      }
      const result = encodeRecord(
        request.file === "omoAgentSettings"
          ? mergeValues(parsed.values, request.values)
          : mergeMcpValues(parsed.values, request.values),
      );
      if (Result.isFailure(result)) {
        return yield* new AgentConfigWriteError({
          file: request.file,
          reason: "write_failed",
          detail: String(result.failure),
        });
      }
      return result.success;
    });

    const stamp = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
    const tmpPath = `${filePath}.${stamp}.tmp`;
    yield* fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(Effect.mapError(writeError("write_failed")));
    yield* fs
      .writeFileString(tmpPath, serialized)
      .pipe(Effect.mapError(writeError("write_failed")));
    yield* fs.rename(tmpPath, filePath).pipe(Effect.mapError(writeError("write_failed")));

    return yield* readAgentConfigFile(request);
  });

/**
 * MCP writes merge one level deeper than settings writes: a patch touching
 * `mcpServers` adds/replaces/removes individual servers instead of replacing
 * the whole map, so editing one server never drops the others.
 */
const mergeMcpValues = (
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
  const { mcpServers: patchServers, ...rest } = patch;
  const next = mergeValues(current, rest);
  if (patchServers === undefined) return next;
  if (patchServers === null) {
    delete next.mcpServers;
    return next;
  }
  const currentServers = next.mcpServers;
  const base =
    typeof currentServers === "object" && currentServers !== null && !Array.isArray(currentServers)
      ? (currentServers as Record<string, unknown>)
      : {};
  const patchRecord =
    typeof patchServers === "object" && !Array.isArray(patchServers)
      ? (patchServers as Record<string, unknown>)
      : {};
  next.mcpServers = mergeValues(base, patchRecord);
  return next;
};
