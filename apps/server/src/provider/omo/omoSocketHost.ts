// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { decodeRecord, encodeJson, type OmoRpcRecord } from "./omoRpcConnection.ts";

const EXTENSION_EVENTS_CAPABILITY = "extension_events";
const MULTI_SESSION_CAPABILITY = "multi_session";
const ENSURE_LOCK_RETRY_MS = 20;
const ENSURE_LOCK_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 10_000;

type ProtocolInfo = { readonly serverVersion: string; readonly capabilities: readonly string[] };
type ManagedHost = { readonly pid: number; readonly processStartTime: string };

export type OmoSocketHostOptions = {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly socketPath: string;
  readonly agentDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly args: readonly string[];
  readonly expectedVersion: string;
};

const daemonDirectory = (agentDir: string) => NodePath.join(agentDir, "rpc-host-daemon");
const lockDirectory = (agentDir: string) => NodePath.join(daemonDirectory(agentDir), "daemon.lock");
const stateFile = (agentDir: string) => NodePath.join(daemonDirectory(agentDir), "host.pid");
const settingsFile = (agentDir: string) =>
  NodePath.join(daemonDirectory(agentDir), "settings.json");
const stderrFile = (agentDir: string) => NodePath.join(daemonDirectory(agentDir), "stderr.log");
const INTERNAL_SUPERVISOR_MODE = "--internal-rpc-host-supervisor";
const delay = (milliseconds: number) => Effect.sleep(milliseconds);

const readManagedHost = (agentDir: string): ManagedHost | undefined => {
  try {
    const value = decodeRecord(NodeFS.readFileSync(stateFile(agentDir), "utf8").trim());
    return typeof value?.pid === "number" && typeof value?.processStartTime === "string"
      ? { pid: value.pid, processStartTime: value.processStartTime }
      : undefined;
  } catch {
    return undefined;
  }
};

const processStartTime = (pid: number): string | undefined => {
  const result = NodeChildProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
};
const managedAlive = (host: ManagedHost | undefined): boolean =>
  host !== undefined && processStartTime(host.pid) === host.processStartTime;

const withEnsureLock = <A, E, R>(agentDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      NodeFS.mkdirSync(daemonDirectory(agentDir), { recursive: true, mode: 0o700 });
      const deadline = (yield* Clock.currentTimeMillis) + ENSURE_LOCK_TIMEOUT_MS;
      for (;;) {
        try {
          NodeFS.mkdirSync(lockDirectory(agentDir), { mode: 0o700 });
          return;
        } catch (error: unknown) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "EEXIST" ||
            (yield* Clock.currentTimeMillis) >= deadline
          )
            throw error;
          yield* delay(ENSURE_LOCK_RETRY_MS);
        }
      }
    }),
    () => effect,
    () =>
      Effect.sync(() => NodeFS.rmSync(lockDirectory(agentDir), { recursive: true, force: true })),
  );

const protocolInfoFrom = (record: OmoRpcRecord | undefined): ProtocolInfo | undefined => {
  const data = record?.data;
  if (record?.success !== true || typeof data !== "object" || data === null) return undefined;
  const serverVersion = Reflect.get(data, "serverVersion");
  const capabilities = Reflect.get(data, "capabilities");
  return typeof serverVersion === "string" &&
    Array.isArray(capabilities) &&
    capabilities.every((value) => typeof value === "string")
    ? { serverVersion, capabilities }
    : undefined;
};

export const probeOmoSocketHost = (
  socketPath: string,
  timeoutMs = 1_000,
): Effect.Effect<ProtocolInfo | undefined> =>
  Effect.callback<ProtocolInfo | undefined>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (value?: ProtocolInfo) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };
    socket.once("connect", () =>
      socket.write(`${encodeJson({ id: "omo-desktop-host-probe", type: "get_protocol_info" })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(protocolInfoFrom(decodeRecord(buffer.slice(0, newline))));
    });
    socket.once("error", () => finish());
    socket.once("close", () => finish());
    return Effect.sync(() => finish());
  }).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map((result) => (result._tag === "Some" ? result.value : undefined)),
  );

const compatible = (info: ProtocolInfo | undefined, expectedVersion: string) =>
  info?.serverVersion === expectedVersion &&
  info.capabilities.includes(MULTI_SESSION_CAPABILITY) &&
  info.capabilities.includes(EXTENSION_EVENTS_CAPABILITY);

export const stopManagedOmoSocketHost = (agentDir: string) =>
  Effect.gen(function* () {
    const host = readManagedHost(agentDir);
    if (host === undefined) return;
    yield* stopManaged(host);
    NodeFS.rmSync(stateFile(agentDir), { force: true });
    NodeFS.rmSync(settingsFile(agentDir), { force: true });
  });

const stopManaged = (host: ManagedHost) =>
  Effect.gen(function* () {
    if (!managedAlive(host)) return;
    yield* Effect.sync(() => process.kill(host.pid, "SIGTERM"));
    const deadline = (yield* Clock.currentTimeMillis) + 3_000;
    while (managedAlive(host) && (yield* Clock.currentTimeMillis) < deadline) yield* delay(20);
    if (managedAlive(host)) yield* Effect.sync(() => process.kill(host.pid, "SIGKILL"));
  }).pipe(Effect.ignore);

const startHost = (options: OmoSocketHostOptions) =>
  Effect.gen(function* () {
    const command = yield* resolveSpawnCommand(options.binaryPath, [...options.args], {
      env: options.env,
    });
    const supervisorCommand = yield* resolveSpawnCommand(
      options.binaryPath,
      [
        INTERNAL_SUPERVISOR_MODE,
        "--socket",
        options.socketPath,
        "--agent-dir",
        options.agentDir,
        "--child-command",
        command.command,
        "--child-args",
        JSON.stringify(command.args),
      ],
      { env: options.env },
    );
    NodeFS.mkdirSync(NodePath.dirname(options.socketPath), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(
      settingsFile(options.agentDir),
      `${JSON.stringify({ socket: options.socketPath, capabilities: [MULTI_SESSION_CAPABILITY, EXTENSION_EVENTS_CAPABILITY], coldStart: "transient", idleExitMs: 900000 })}\n`,
      { mode: 0o600 },
    );
    const stderrFd = NodeFS.openSync(stderrFile(options.agentDir), "w", 0o600);
    const supervisor = NodeChildProcess.spawn(supervisorCommand.command, supervisorCommand.args, {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      shell: supervisorCommand.shell,
      stdio: ["ignore", "ignore", stderrFd],
    });
    NodeFS.closeSync(stderrFd);
    let spawnError: Error | undefined;
    supervisor.once("error", (error) => {
      spawnError = error;
    });
    supervisor.unref();
    if (supervisor.pid === undefined)
      throw new Error("omo socket host supervisor did not return a pid");
    const started = processStartTime(supervisor.pid);
    if (started === undefined)
      throw new Error("omo socket host supervisor had no process start time");
    const managed: ManagedHost = { pid: supervisor.pid, processStartTime: started };
    NodeFS.writeFileSync(stateFile(options.agentDir), `${JSON.stringify(managed)}\n`, {
      mode: 0o600,
    });
    const deadline = (yield* Clock.currentTimeMillis) + READINESS_TIMEOUT_MS;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (spawnError !== undefined) throw spawnError;
      const info = yield* probeOmoSocketHost(options.socketPath, 500);
      if (compatible(info, options.expectedVersion)) return managed;
      yield* delay(50);
    }
    if (spawnError !== undefined) throw spawnError;
    yield* stopManaged(managed);
    NodeFS.rmSync(stateFile(options.agentDir), { force: true });
    NodeFS.rmSync(settingsFile(options.agentDir), { force: true });
    NodeFS.rmSync(options.socketPath, { force: true });
    const stderr = (() => {
      try {
        return NodeFS.readFileSync(stderrFile(options.agentDir), "utf8").trim();
      } catch {
        return "";
      }
    })();
    throw new Error(`omo socket host failed compatibility probe${stderr ? `: ${stderr}` : ""}`);
  });

export const ensureOmoSocketHost = (options: OmoSocketHostOptions): Effect.Effect<void> =>
  withEnsureLock(
    options.agentDir,
    Effect.gen(function* () {
      const info = yield* probeOmoSocketHost(options.socketPath);
      const managed = readManagedHost(options.agentDir);
      if (compatible(info, options.expectedVersion)) return;
      if (info !== undefined && !managedAlive(managed))
        return yield* Effect.die(
          new Error(
            `omo RPC socket ${options.socketPath} is owned by an incompatible unmanaged host`,
          ),
        );
      if (managed !== undefined && managedAlive(managed)) yield* stopManaged(managed);
      NodeFS.rmSync(stateFile(options.agentDir), { force: true });
      if (info === undefined) NodeFS.rmSync(options.socketPath, { force: true });
      yield* startHost(options);
    }),
  );
