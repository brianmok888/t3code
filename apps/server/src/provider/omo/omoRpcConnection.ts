import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

export type OmoRequestKind = "open_session" | "close_session" | "probe" | "turn" | "control";
export type OmoRpcRecord = Readonly<Record<string, unknown>>;
export type OmoSharedProcessState =
  | "stopped"
  | "starting"
  | "running"
  | "backoff"
  | "degraded"
  | "disposed";
export type OmoSharedProcessHealth = {
  readonly state: OmoSharedProcessState;
  readonly epoch: number;
  readonly consecutiveFailures: number;
};
export interface OmoSharedProcessOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  /** Configured shared-host Unix socket. Defaults to <agentDir>/rpc/rpc.sock. */
  readonly socketPath?: string;
  /** Test-only seam for an in-process socket host. */
  readonly socketTransport?: {
    readonly ensure?: Effect.Effect<void, OmoSharedProcessError>;
    readonly connect: (
      socketPath: string,
    ) => Effect.Effect<import("node:net").Socket, OmoSharedProcessError, Scope.Scope>;
    readonly expectedVersion?: string;
  };
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Raw `omo --version` output for the binary at `binaryPath`, used ONLY to
   * gate engine flags that older engines would reject as unknown options.
   * Leave undefined when no probe result is available — every gate that reads
   * this must then omit its flag (fail safe).
   */
  readonly engineVersion?: string;
  readonly jitter?: (maximumMs: number) => Effect.Effect<number>;
  readonly sleep?: (milliseconds: number) => Effect.Effect<void>;
  /** Override the D4 idle-shutdown threshold (zero open sessions -> expected exit). Test-only. */
  /**
   * Called with the pid of every child that becomes the live epoch, and again
   * when that child exits. The supervisor stays ignorant of WHY (the omo
   * orphan registry uses it to record ownership across service restarts);
   * failures must be swallowed by the callback, never surfaced as spawn errors.
   */
  readonly onChildSpawned?: (pid: number) => Effect.Effect<void>;
  readonly onChildExited?: (pid: number) => Effect.Effect<void>;
  /** Deterministic lifecycle interleaving hooks used only by supervisor tests. */
  readonly testHooks?: {
    readonly beforeEnqueueRegistration?: Effect.Effect<void>;
    readonly beforeRecordSettlement?: (record: OmoRpcRecord) => Effect.Effect<void>;
    readonly afterRecordSettlement?: (record: OmoRpcRecord) => Effect.Effect<void>;
    readonly afterExitInvalidation?: Effect.Effect<void>;
    readonly afterProbeResponseBeforeStableTimer?: Effect.Effect<void>;
  };
}
export interface OmoSharedProcess {
  readonly request: (
    record: OmoRpcRecord,
    kind?: OmoRequestKind,
  ) => Effect.Effect<OmoRpcRecord, OmoSharedProcessError>;
  /** Writes one-way native records (notably extension_ui_response) without replacing their id. */
  readonly notify: (record: OmoRpcRecord) => Effect.Effect<void, OmoSharedProcessError>;
  readonly records: Stream.Stream<{
    readonly epoch: number;
    readonly record: OmoRpcRecord;
  }>;
  readonly health: Stream.Stream<OmoSharedProcessHealth>;
  readonly state: Effect.Effect<OmoSharedProcessHealth>;
  /**
   * Atomically verifies an open-session epoch is still live while handing its
   * adapter context to the event dispatcher. The callback is synchronous so
   * exit invalidation cannot land between the check and registration.
   */
  readonly registerSession: (
    epoch: number,
    register: () => void,
  ) => Effect.Effect<void, OmoSharedProcessExited>;
  /** Current supervisor-owned RPC child PID, if it has been started. */
  readonly pids?: Effect.Effect<ReadonlyArray<number>>;
  /**
   * Clears a DEGRADED supervisor so the next demand re-probes (no-op otherwise).
   * Does NOT touch a running epoch — use {@link forceRestart} for a wedged child.
   */
  readonly refresh: Effect.Effect<void>;
  /**
   * Force-restarts a running/starting epoch: atomically invalidates the epoch
   * (clears running/handles/pending), fails in-flight RPC deferreds, gracefully
   * stops the child, and lets the next demand respawn. Used by bounded-abort
   * recovery when a running omo stops acknowledging `{ type: "abort" }`.
   * Optional: callers fall back to {@link refresh} when absent.
   */
  readonly forceRestart?: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}
export type Running = {
  readonly epoch: number;
  readonly stdin: Queue.Queue<Uint8Array, never>;
  readonly child: ChildProcessHandle;
};

export class OmoSharedProcessExited extends Schema.TaggedError<OmoSharedProcessExited>()(
  "OmoSharedProcessExited",
  {
    epoch: Schema.Number,
    exitCode: Schema.NullOr(Schema.Number),
    stderrTail: Schema.String,
  },
) {}
export class OmoSharedProcessSpawnFailed extends Schema.TaggedError<OmoSharedProcessSpawnFailed>()(
  "OmoSharedProcessSpawnFailed",
  { binaryPath: Schema.String, cause: Schema.Defect() },
) {}
export class OmoSharedProcessRequestFailed extends Schema.TaggedError<OmoSharedProcessRequestFailed>()(
  "OmoSharedProcessRequestFailed",
  { command: Schema.String, detail: Schema.String },
) {}
export type OmoSharedProcessError =
  | OmoSharedProcessExited
  | OmoSharedProcessSpawnFailed
  | OmoSharedProcessRequestFailed;
export type PendingRequest = {
  readonly epoch: number;
  readonly kind: OmoRequestKind;
  readonly command: string;
  readonly deferred: Deferred.Deferred<OmoRpcRecord, OmoSharedProcessError>;
};
export type SupervisorState = {
  readonly state: OmoSharedProcessState;
  readonly desiredRunning: boolean;
  readonly epoch: number;
  readonly running: Running | undefined;
  /** The single-flight startup result shared by every concurrent demand. */
  readonly starting: Deferred.Deferred<Running, OmoSharedProcessError> | undefined;
  readonly pending: ReadonlyMap<string, PendingRequest>;
  readonly handles: ReadonlyMap<string, number>;
  readonly failures: readonly number[];
  readonly stderr: Uint8Array;
};

const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeRecord = (line: string): OmoRpcRecord | undefined => {
  const decoded = decodeJson(line);
  return Result.isSuccess(decoded) && isRecord(decoded.success) ? decoded.success : undefined;
};
export const isRecord = (value: unknown): value is OmoRpcRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const settleRecord = <
  State extends { readonly pending: ReadonlyMap<string, PendingRequest> },
>(
  record: OmoRpcRecord,
  epoch: number,
  state: Ref.Ref<State>,
  events: PubSub.PubSub<{
    readonly epoch: number;
    readonly record: OmoRpcRecord;
  }>,
) =>
  Effect.gen(function* () {
    const id = typeof record.id === "string" ? record.id : undefined;
    const pending = id === undefined ? undefined : (yield* Ref.get(state)).pending.get(id);
    if (id === undefined || pending === undefined || pending.epoch !== epoch) {
      yield* PubSub.publish(events, { epoch, record });
      return;
    }
    const pendingId = id;
    yield* Ref.update(state, (current) => {
      const next = new Map(current.pending);
      next.delete(pendingId);
      return { ...current, pending: next };
    });
    if (record.success === false) {
      yield* Deferred.fail(
        pending.deferred,
        new OmoSharedProcessRequestFailed({
          command: pending.command,
          detail: typeof record.error === "string" ? record.error : "omo request failed",
        }),
      );
      return;
    }
    // Preserve the epoch at which this response was accepted. It is metadata
    // only (never written to the wire) and closes the open_session read-after-
    // response race in the adapter.
    yield* Deferred.succeed(pending.deferred, { ...record, __omoEpoch: epoch });
  });

export const appendStderrTail = (current: Uint8Array, chunk: Uint8Array, maximum: number) => {
  const next = new Uint8Array(current.length + chunk.length);
  next.set(current);
  next.set(chunk, current.length);
  return next.length <= maximum ? next : next.slice(next.length - maximum);
};
