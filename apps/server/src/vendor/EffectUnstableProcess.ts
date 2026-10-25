// Port shim (omo fork): reconstructs the slice of effect-3's experimental
// `effect/unstable/process` module that the ported omo provider layers use,
// on top of effect@4 + node:child_process.
//   ChildProcess.make(cmd, args, opts) -> Effect<Command>
//   ChildProcessSpawner (Context.Service class = the tag)
//     .spawn(command) -> scoped handle { stdout, stderr, exitCode, kill }
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCP from "node:child_process";

export type Command = ProviderCommandSpec;

export class ChildProcessSpawnError extends Schema.TaggedError<ChildProcessSpawnError>()(
  "ChildProcessSpawnError",
  {
    command: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: {
    readonly env?: Record<string, string | undefined>;
    readonly shell?: string | boolean;
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly killSignal?: NodeJS.Signals | number;
    readonly forceKillAfter?: number | string | Duration.Duration;
  };
}

export interface ChildProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: Stream.Stream<Uint8Array, ChildProcessSpawnError>;
  readonly stderr: Stream.Stream<Uint8Array, ChildProcessSpawnError>;
  readonly exitCode: Effect.Effect<number>;
  readonly kill: (options?: {
    readonly killSignal?: NodeJS.Signals | number;
    readonly forceKillAfter?: number | string | Duration.Duration;
  }) => Effect.Effect<void>;
}

export interface ChildProcessSpawnerService {
  readonly spawn: (
    command: Command,
  ) => Effect.Effect<ChildProcessHandle, ChildProcessSpawnError, Scope.Scope>;
}

export declare namespace ChildProcess {
  export type Command = ProviderCommandSpec;
}

export const ChildProcess = {
  make: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ProviderCommandSpec["options"],
  ): ProviderCommandSpec => ({ command, args: [...args], options: options ?? {} }),
};

export class ChildProcessSpawner extends Context.Service<
  ChildProcessSpawner,
  ChildProcessSpawnerService
>()("omo/vendor/effect-unstable-process/ChildProcessSpawner") {}

const streamFromReadable = (
  readable: NodeJS.ReadableStream | null,
): Stream.Stream<Uint8Array, ChildProcessSpawnError> => {
  if (!readable) return Stream.empty;
  return Stream.fromAsyncIterable(
    readable as AsyncIterable<Uint8Array>,
    (cause) => new ChildProcessSpawnError({ command: "stream", cause }),
  );
};

export const makeNodeChildProcessSpawner = (): ChildProcessSpawnerService => ({
  spawn: (spec) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = NodeCP.spawn(spec.command, [...spec.args], {
            env: spec.options?.env as NodeJS.ProcessEnv | undefined,
            shell: spec.options?.shell as NodeCP.SpawnOptions["shell"],
            killSignal: spec.options?.killSignal as NodeCP.SpawnOptions["killSignal"],
            cwd: spec.options?.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exitCode = Effect.callback<number>((resume) => {
            const onExit = (code: number | null): void =>
              resume(Effect.succeed(code === null ? -1 : code));
            const onError = (): void => resume(Effect.succeed(-1));
            child.once("exit", onExit);
            child.once("error", onError);
            return Effect.sync(() => {
              child.off("exit", onExit);
              child.off("error", onError);
            });
          });
          const handle: ChildProcessHandle = {
            pid: child.pid,
            stdout: streamFromReadable(child.stdout),
            stderr: streamFromReadable(child.stderr),
            exitCode,
            // shim scope: SIGTERM only; forceKillAfter escalation not implemented
            kill: Effect.sync(() => {
              if (child.exitCode === null) {
                child.kill((spec.options?.killSignal ?? "SIGTERM") as NodeJS.Signals);
              }
            }),
          };
          return handle;
        },
        catch: (cause) => new ChildProcessSpawnError({ command: spec.command, cause }),
      }),
      (handle) => handle.kill(),
    ),
});
