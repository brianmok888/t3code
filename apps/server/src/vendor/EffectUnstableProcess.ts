// Port shim (omo fork): effect 3.x shipped an experimental
// `effect/unstable/process` module (ChildProcessSpawner service +
// ChildProcess.make command specs). effect@4.0.5 no longer exposes it, so the
// surface actually consumed by the ported omo provider layers is
// reconstructed here on node:child_process:
//   ChildProcess.make(cmd, args, opts) -> Effect<Command>
//   ChildProcessSpawner.ChildProcessSpawner -> Tag providing { spawn }
//   spawner.spawn(command) -> scoped handle { stdout, stderr, exitCode, kill }
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeCP from "node:child_process";

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
  };
}

export interface ChildProcessHandle {
  readonly pid: number | undefined;
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exitCode: Effect.Effect<number>;
  readonly kill: Effect.Effect<void>;
}

export interface ChildProcessSpawnerService {
  readonly spawn: (
    command: ProviderCommandSpec,
  ) => Effect.Effect<ChildProcessHandle, ChildProcessSpawnError, Scope.Scope>;
}

const streamFromReadable = (readable: NodeJS.ReadableStream | null): Stream.Stream<Uint8Array> => {
  if (!readable) return Stream.empty;
  return Stream.fromAsyncIterable(
    readable as AsyncIterable<Uint8Array>,
    (cause) => new ChildProcessSpawnError({ command: "stream", cause }),
  );
};

export const ChildProcess = {
  make: (
    command: string,
    args: ReadonlyArray<string>,
    options?: ProviderCommandSpec["options"],
  ): Effect.Effect<ProviderCommandSpec> =>
    Effect.succeed({ command, args: [...args], options: options ?? {} }),
};

export class ChildProcessSpawner {
  static readonly ChildProcessSpawner: Context.Tag<
    ChildProcessSpawner,
    ChildProcessSpawnerService
  > = Context.GenericTag<ChildProcessSpawner, ChildProcessSpawnerService>(
    "omo/vendor/effect-unstable-process/ChildProcessSpawner",
  );
}

export declare namespace ChildProcess {
  export type Command = ProviderCommandSpec;
}

export const makeNodeChildProcessSpawner = (): ChildProcessSpawnerService => ({
  spawn: (spec) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const child = NodeCP.spawn(spec.command, [...spec.args], {
            env: spec.options?.env as NodeJS.ProcessEnv | undefined,
            shell: spec.options?.shell as NodeCP.SpawnOptions["shell"],
            cwd: spec.options?.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exitCode = Effect.async<number>((resume) => {
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
            kill: Effect.sync(() => {
              if (child.exitCode === null) child.kill("SIGTERM");
            }),
          };
          return handle;
        },
        catch: (cause) => new ChildProcessSpawnError({ command: spec.command, cause }),
      }),
      (handle) => handle.kill,
    ),
});
