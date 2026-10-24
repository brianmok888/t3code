// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveOmoCodingAgentDir } from "../omo/omoAgentSettings.ts";
import { makeOmoChildEnvironment } from "../omo/omoChildEnvironment.ts";
import { buildOmoTelemetrySpawnEnv } from "../omo/omoTelemetryAttribution.ts";
import {
  decodeRecord,
  encodeJson,
  OmoSharedProcessExited,
  OmoSharedProcessRequestFailed,
  OmoSharedProcessSpawnFailed,
  type OmoRequestKind,
  type OmoRpcRecord,
  type OmoSharedProcess,
  type OmoSharedProcessError,
  type OmoSharedProcessHealth,
  type OmoSharedProcessOptions,
  type PendingRequest,
} from "../omo/omoRpcConnection.ts";
import { ensureOmoSocketHost, stopManagedOmoSocketHost } from "../omo/omoSocketHost.ts";

export {
  OmoSharedProcessRequestFailed,
  OmoSharedProcessSpawnFailed,
} from "../omo/omoRpcConnection.ts";
export type {
  OmoRequestKind,
  OmoRpcRecord,
  OmoSharedProcess,
  OmoSharedProcessError,
  OmoSharedProcessHealth,
  OmoSharedProcessOptions,
} from "../omo/omoRpcConnection.ts";

const OMO_PLUGIN_PATH_ENV = "T3CODE_OMO_PLUGIN_PATH";
const GLOBAL_BUN_OMO_PLUGIN_PATH = "/Users/yeongyu/.bun/install/global/node_modules/omo-ai/plugin";
const RPC_ARGS = ["--mode", "rpc", "--multi-session"] as const;
const EXTENSION_EVENTS_CAPABILITY = "extension_events";
const OMO_SENPI_BRAND = JSON.stringify({
  name: "omo",
  configDir: ".omo",
  flatLayout: false,
  envPrefix: "OMO",
  userAgent: "omo",
  originator: "omo",
});

const existingDirectory = (candidate: string): string | undefined => {
  try {
    return NodeFS.statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const resolveMainCheckoutRoot = (start: string): string | undefined => {
  let directory = NodePath.resolve(start);
  for (;;) {
    const gitPath = NodePath.join(directory, ".git");
    try {
      const stat = NodeFS.statSync(gitPath);
      if (stat.isDirectory()) return directory;
      if (stat.isFile()) {
        const gitDirValue = NodeFS.readFileSync(gitPath, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.startsWith("gitdir:"))
          ?.slice("gitdir:".length)
          .trim();
        if (!gitDirValue) return directory;
        const gitDirectory = NodePath.resolve(directory, gitDirValue);
        return NodePath.basename(NodePath.dirname(gitDirectory)) === "worktrees"
          ? NodePath.dirname(NodePath.dirname(NodePath.dirname(gitDirectory)))
          : directory;
      }
    } catch {
      // Keep walking until the repository root is found.
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const isOmoLauncher = (configuredPath: string, resolvedPath: string): boolean =>
  [configuredPath, resolvedPath]
    .map((value) => value.toLowerCase())
    .some((value) => value.includes("omo-ai") || NodePath.basename(value) === "omo");

const resolveOmoPluginPath = (env: NodeJS.ProcessEnv): string | undefined => {
  const override = env[OMO_PLUGIN_PATH_ENV]?.trim();
  if (override) return existingDirectory(override);
  const globalPlugin = existingDirectory(GLOBAL_BUN_OMO_PLUGIN_PATH);
  if (globalPlugin) return globalPlugin;
  const mainCheckoutRoot = resolveMainCheckoutRoot(process.cwd());
  return mainCheckoutRoot === undefined
    ? undefined
    : existingDirectory(NodePath.resolve(mainCheckoutRoot, "../omo/packages/omo-senpi/plugin"));
};

export const appendCapability = (value: string | undefined): string =>
  [
    ...new Set([
      ...(value ?? "")
        .split(",")
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
      EXTENSION_EVENTS_CAPABILITY,
    ]),
  ].join(",");

type OmoStdoutReaderItem =
  | { readonly _tag: "Line"; readonly line: string }
  | { readonly _tag: "Drain"; readonly drained: Deferred.Deferred<void> };

export const runOmoStdoutReader = <E, R>(
  lines: Stream.Stream<string, E, R>,
  processLine: (line: string) => Effect.Effect<void>,
  scope: Scope.Scope,
  onProducerAwait?: Effect.Effect<void>,
): Effect.Effect<{ readonly drain: Effect.Effect<void> }, never, R> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<OmoStdoutReaderItem>();
    const consumer = yield* Stream.fromQueue(queue).pipe(
      Stream.runForEach((item) =>
        item._tag === "Line"
          ? processLine(item.line)
          : Deferred.succeed(item.drained, undefined).pipe(Effect.asVoid),
      ),
      Effect.forkIn(scope),
    );
    const producer = yield* lines.pipe(
      Stream.runForEach((line) => Queue.offer(queue, { _tag: "Line", line })),
      Effect.forkIn(scope),
    );
    return {
      drain: Effect.gen(function* () {
        yield* onProducerAwait ?? Effect.void;
        yield* Fiber.await(producer);
        const drained = yield* Deferred.make<void>();
        yield* Queue.offer(queue, { _tag: "Drain", drained });
        yield* Effect.race(Deferred.await(drained), Fiber.await(consumer).pipe(Effect.asVoid));
      }),
    };
  });

type SocketConnection = {
  readonly epoch: number;
  readonly socket: NodeNet.Socket;
};

type SocketState = {
  readonly disposed: boolean;
  readonly epoch: number;
  readonly connection: SocketConnection | undefined;
  readonly connecting: Deferred.Deferred<SocketConnection, OmoSharedProcessError> | undefined;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly handles: ReadonlyMap<string, number>;
};

const healthOf = (state: SocketState): OmoSharedProcessHealth => ({
  state: state.disposed
    ? "disposed"
    : state.connection
      ? "running"
      : state.connecting
        ? "starting"
        : state.epoch > 0
          ? "backoff"
          : "stopped",
  epoch: state.epoch,
  consecutiveFailures: state.epoch > 0 && !state.connection ? 1 : 0,
});

const expectedBinaryVersion = (command: {
  command: string;
  args: readonly string[];
  shell: boolean;
}) => {
  const result = NodeChildProcess.spawnSync(command.command, [...command.args], {
    encoding: "utf8",
    shell: command.shell,
  });
  const version = (result.stdout ?? "").trim();
  if (result.status !== 0 || version.length === 0)
    throw result.error ?? new Error("omo --version failed");
  return version;
};

export const makeOmoSharedProcess = Effect.fn("makeOmoSharedProcess")(function* (
  options: OmoSharedProcessOptions,
): Effect.fn.Return<OmoSharedProcess, never, Scope.Scope> {
  const parentScope = yield* Scope.Scope;
  const env = makeOmoChildEnvironment(yield* HostProcessEnvironment, options.env);
  const resolvedCodingAgentDir = yield* resolveOmoCodingAgentDir(env).pipe(
    Effect.provide(Path.layer),
  );
  const codingAgentDir =
    process.env.VITEST === "true" &&
    options.socketTransport === undefined &&
    options.env?.OMO_CODING_AGENT_DIR === undefined &&
    env.OMO_CODING_AGENT_DIR === undefined
      ? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omo-vitest-agent-"))
      : resolvedCodingAgentDir;
  if (
    process.env.VITEST === "true" &&
    NodePath.resolve(codingAgentDir) ===
      NodePath.resolve(NodePath.join(process.env.HOME ?? NodeOS.homedir(), ".omo", "agent"))
  )
    throw new Error(
      `omo test transport refused real agent directory before ensure/cleanup: ${codingAgentDir}`,
    );
  const socketPath = options.socketPath ?? NodePath.join(codingAgentDir, "rpc", "rpc.sock");
  const baseCommand = yield* resolveSpawnCommand(options.binaryPath, RPC_ARGS, { env });
  const launcher = isOmoLauncher(options.binaryPath, baseCommand.command);
  const pluginOverride = env[OMO_PLUGIN_PATH_ENV]?.trim();
  const pluginPath = launcher
    ? undefined
    : pluginOverride === undefined
      ? resolveOmoPluginPath(env)
      : existingDirectory(pluginOverride);
  if (!launcher && pluginOverride !== undefined && pluginPath === undefined)
    yield* Effect.logWarning("plugin_unavailable", { path: pluginOverride });
  const rpcArgs = pluginPath === undefined ? RPC_ARGS : [...RPC_ARGS, "--extension", pluginPath];
  const spawnEnv = {
    ...env,
    OMO_CODING_AGENT_DIR: codingAgentDir,
    ...buildOmoTelemetrySpawnEnv(codingAgentDir),
    SENPI_CODING_AGENT_DIR: codingAgentDir,
    OMO_RPC_CLIENT_CAPABILITIES: appendCapability(env.OMO_RPC_CLIENT_CAPABILITIES),
    SENPI_RPC_CLIENT_CAPABILITIES: appendCapability(env.SENPI_RPC_CLIENT_CAPABILITIES),
    ...(pluginPath === undefined ? {} : { OMO_NATIVE: "1", SENPI_BRAND: OMO_SENPI_BRAND }),
  };
  const versionCommand = yield* resolveSpawnCommand(options.binaryPath, ["--version"], {
    env: spawnEnv,
  });
  const expectedVersion = options.socketTransport?.expectedVersion;
  const state = yield* Ref.make<SocketState>({
    disposed: false,
    epoch: 0,
    connection: undefined,
    connecting: undefined,
    pending: new Map(),
    handles: new Map(),
  });
  const events = yield* PubSub.unbounded<{
    readonly epoch: number;
    readonly record: OmoRpcRecord;
  }>();
  const health = yield* PubSub.unbounded<OmoSharedProcessHealth>();
  let nextId = 1;

  const publishHealth = Ref.get(state).pipe(
    Effect.flatMap((current) => PubSub.publish(health, healthOf(current))),
    Effect.asVoid,
  );

  const invalidate = (connection: SocketConnection, reason: string) =>
    Effect.gen(function* () {
      const invalidated = yield* Ref.modify(state, (current) => {
        if (current.connection !== connection) return [undefined, current] as const;
        const pending = [...current.pending.values()].filter(
          (entry) => entry.epoch === connection.epoch,
        );
        return [
          pending,
          { ...current, connection: undefined, pending: new Map(), handles: new Map() },
        ] as const;
      });
      if (invalidated === undefined) return;
      yield* options.testHooks?.afterExitInvalidation ?? Effect.void;
      yield* PubSub.publish(events, {
        epoch: connection.epoch,
        record: { _tag: "OmoSharedProcessExit", exitCode: null, stderrTail: reason },
      });
      const error = new OmoSharedProcessExited({
        epoch: connection.epoch,
        exitCode: null,
        stderrTail: reason,
      });
      yield* Effect.forEach(
        invalidated,
        (entry) =>
          entry.kind === "close_session"
            ? Deferred.succeed(entry.deferred, {})
            : Deferred.fail(entry.deferred, error),
        { discard: true },
      );
      yield* publishHealth;
    });

  const settle = (connection: SocketConnection, record: OmoRpcRecord) =>
    Effect.gen(function* () {
      yield* options.testHooks?.beforeRecordSettlement?.(record) ?? Effect.void;
      const id = typeof record.id === "string" ? record.id : undefined;
      const pending = id === undefined ? undefined : (yield* Ref.get(state)).pending.get(id);
      if (pending === undefined || pending.epoch !== connection.epoch) {
        yield* PubSub.publish(events, { epoch: connection.epoch, record });
      } else {
        yield* Ref.update(state, (current) => {
          const next = new Map(current.pending);
          next.delete(id!);
          const handles = new Map(current.handles);
          const data = record.data;
          if (
            pending.kind === "open_session" &&
            record.success !== false &&
            typeof data === "object" &&
            data !== null &&
            typeof Reflect.get(data, "sessionId") === "string"
          )
            handles.set(Reflect.get(data, "sessionId") as string, connection.epoch);
          if (pending.kind === "close_session" && typeof record.sessionId === "string")
            handles.delete(record.sessionId);
          return { ...current, pending: next, handles };
        });
        if (record.success === false) {
          yield* Deferred.fail(
            pending.deferred,
            new OmoSharedProcessRequestFailed({
              command: pending.command,
              detail: typeof record.error === "string" ? record.error : "omo request failed",
            }),
          );
        } else {
          yield* Deferred.succeed(pending.deferred, { ...record, __omoEpoch: connection.epoch });
        }
      }
      yield* options.testHooks?.afterRecordSettlement?.(record) ?? Effect.void;
    });

  const connect = (epoch: number) =>
    Effect.gen(function* () {
      if (epoch > 1)
        yield* options.sleep?.(Math.min(1_000, 50 * 2 ** Math.min(epoch - 2, 5))) ?? Effect.void;
      if (
        process.env.VITEST === "true" &&
        options.socketTransport === undefined &&
        options.binaryPath === "omo"
      )
        return yield* Effect.fail(
          new OmoSharedProcessSpawnFailed({
            binaryPath: options.binaryPath,
            cause: new Error("unconfigured test transport cannot spawn omo"),
          }),
        );
      const version =
        expectedVersion ??
        (yield* Effect.try({
          try: () => expectedBinaryVersion(versionCommand),
          catch: (cause) =>
            new OmoSharedProcessSpawnFailed({ binaryPath: options.binaryPath, cause }),
        }));
      if (options.socketTransport?.ensure) yield* options.socketTransport.ensure;
      else
        yield* ensureOmoSocketHost({
          binaryPath: options.binaryPath,
          cwd: options.cwd,
          socketPath,
          agentDir: codingAgentDir,
          env: spawnEnv,
          args: rpcArgs,
          expectedVersion: version,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(new OmoSharedProcessSpawnFailed({ binaryPath: options.binaryPath, cause })),
          ),
        );
      const socket = options.socketTransport
        ? yield* options.socketTransport
            .connect(socketPath)
            .pipe(Effect.provideService(Scope.Scope, parentScope))
        : yield* Effect.callback<NodeNet.Socket, OmoSharedProcessError>((resume) => {
            const peer = NodeNet.createConnection(socketPath);
            const onError = (cause: Error) => {
              peer.destroy();
              resume(
                Effect.fail(
                  new OmoSharedProcessSpawnFailed({ binaryPath: options.binaryPath, cause }),
                ),
              );
            };
            peer.once("error", onError);
            peer.once("connect", () => {
              peer.off("error", onError);
              resume(Effect.succeed(peer));
            });
            return Effect.sync(() => peer.destroy());
          });
      const connection = { epoch, socket } satisfies SocketConnection;
      let buffer = "";
      let disconnected = false;
      const disconnect = (reason: string) => {
        if (disconnected) return;
        disconnected = true;
        Effect.runFork(invalidate(connection, reason));
      };
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const record = decodeRecord(line);
          if (record !== undefined) Effect.runFork(settle(connection, record));
        }
      });
      socket.once("error", (error) => disconnect(`omo socket error: ${error.message}`));
      socket.once("end", () => disconnect("omo socket host disconnected"));
      socket.once("close", () => disconnect("omo socket host connection closed"));
      return connection;
    });

  type DemandDecision =
    | { readonly tag: "running"; readonly value: SocketConnection }
    | {
        readonly tag: "waiting";
        readonly value: Deferred.Deferred<SocketConnection, OmoSharedProcessError>;
      }
    | { readonly tag: "disposed" }
    | { readonly tag: "owner"; readonly epoch: number };
  const demand = Effect.gen(function* () {
    const startup = yield* Deferred.make<SocketConnection, OmoSharedProcessError>();
    const decision = yield* Ref.modify(state, (current): readonly [DemandDecision, SocketState] => {
      if (current.connection)
        return [{ tag: "running" as const, value: current.connection }, current] as const;
      if (current.connecting)
        return [{ tag: "waiting" as const, value: current.connecting }, current] as const;
      if (current.disposed) return [{ tag: "disposed" as const }, current] as const;
      const epoch = current.epoch + 1;
      return [
        { tag: "owner" as const, epoch },
        { ...current, epoch, connecting: startup },
      ] as const;
    });
    if (decision.tag === "running") return decision.value;
    if (decision.tag === "waiting") return yield* Deferred.await(decision.value);
    if (decision.tag === "disposed")
      return yield* new OmoSharedProcessRequestFailed({
        command: "connect",
        detail: "omo socket client is disposed",
      });
    yield* publishHealth;
    const result = yield* connect(decision.epoch).pipe(Effect.result);
    if (Result.isFailure(result)) {
      const failure = result.failure;
      yield* Ref.update(state, (current) => ({ ...current, connecting: undefined }));
      yield* Deferred.fail(startup, failure);
      yield* publishHealth;
      return yield* failure;
    }
    const connection = result.success;
    yield* Ref.update(state, (current) => ({ ...current, connection, connecting: undefined }));
    yield* Deferred.succeed(startup, connection);
    yield* publishHealth;
    return connection;
  });

  const request = (record: OmoRpcRecord, kind: OmoRequestKind = "control") =>
    Effect.gen(function* () {
      const connection = yield* demand;
      const id = `omo_shared_${nextId++}`;
      const deferred = yield* Deferred.make<OmoRpcRecord, OmoSharedProcessError>();
      yield* options.testHooks?.beforeEnqueueRegistration ?? Effect.void;
      const registered = yield* Ref.modify(state, (current) => {
        if (current.connection !== connection) return [false, current] as const;
        return [
          true,
          {
            ...current,
            pending: new Map(current.pending).set(id, {
              epoch: connection.epoch,
              kind,
              command: String(record.type ?? "unknown"),
              deferred,
            }),
          },
        ] as const;
      });
      if (!registered)
        return yield* new OmoSharedProcessExited({
          epoch: connection.epoch,
          exitCode: null,
          stderrTail: "socket disconnected before request registration",
        });
      connection.socket.write(`${encodeJson({ ...record, id })}\n`);
      return yield* Deferred.await(deferred);
    });

  const notify = (record: OmoRpcRecord) =>
    demand.pipe(
      Effect.flatMap((connection) =>
        Effect.sync(() => {
          connection.socket.write(`${encodeJson(record)}\n`);
        }),
      ),
    );

  const registerSession = (epoch: number, register: () => void) =>
    Ref.get(state).pipe(
      Effect.flatMap((current) => {
        if (current.connection?.epoch === epoch) {
          register();
          return Effect.void;
        }
        return Effect.fail(
          new OmoSharedProcessExited({
            epoch,
            exitCode: null,
            stderrTail: "socket connection changed",
          }),
        );
      }),
    );

  const disconnect = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    current.connection?.socket.destroy();
  });
  const forceRestart = Effect.gen(function* () {
    yield* disconnect;
    yield* stopManagedOmoSocketHost(codingAgentDir);
  });
  const stop = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    yield* Ref.set(state, { ...current, disposed: true, connecting: undefined });
    current.connection?.socket.destroy();
    yield* publishHealth;
  });
  yield* Scope.addFinalizer(parentScope, stop);

  return {
    request,
    notify,
    records: Stream.fromPubSub(events),
    health: Stream.fromPubSub(health),
    state: Ref.get(state).pipe(Effect.map(healthOf)),
    pids: Effect.sync(() => {
      try {
        const value = decodeRecord(
          NodeFS.readFileSync(
            NodePath.join(codingAgentDir, "rpc-host-daemon", "host.pid"),
            "utf8",
          ).trim(),
        );
        return typeof value?.pid === "number" ? [value.pid] : [];
      } catch {
        return [];
      }
    }),
    refresh: disconnect,
    forceRestart,
    registerSession,
    stop,
  };
});
