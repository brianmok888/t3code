// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../../textGeneration/TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../../textGeneration/TextGenerationUtils.ts";
import { decodeOmoModelSlug } from "../omo/omoMappers.ts";

const OMO_TIMEOUT_MS = 180_000;

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

interface OmoCommandExecution {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

interface OmoCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

class OmoCommandError extends Schema.TaggedError<OmoCommandError>()("OmoCommandError", {
  cause: Schema.Defect(),
}) {}

type OmoCommandExecutor = (
  execution: OmoCommandExecution,
) => Effect.Effect<OmoCommandResult, OmoCommandError>;

export interface MakeOmoTextGenerationOptions {
  readonly binaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly execute?: OmoCommandExecutor;
}

const executeOmoCommand = (environment: NodeJS.ProcessEnv | undefined): OmoCommandExecutor =>
  Effect.fn("OmoTextGeneration.executeCommand")(function* (execution) {
    const resolvedEnvironment = environment ?? (yield* HostProcessEnvironment);
    const spawnCommand = yield* resolveSpawnCommand(execution.binaryPath, execution.args, {
      env: resolvedEnvironment,
    });

    return yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<OmoCommandResult>((resolve, reject) => {
          const child = NodeChildProcess.execFile(
            spawnCommand.command,
            [...spawnCommand.args],
            {
              cwd: execution.cwd,
              env: resolvedEnvironment,
              encoding: "utf8",
              maxBuffer: 4 * 1024 * 1024,
              shell: spawnCommand.shell,
              signal,
            },
            (error, stdout, stderr) => {
              if (error !== null && typeof error.code === "string") {
                reject(error);
                return;
              }
              resolve({
                stdout,
                stderr,
                exitCode: error !== null && typeof error.code === "number" ? error.code : 0,
              });
            },
          );
          child.stdin?.end();
        }),
      catch: (cause) => new OmoCommandError({ cause }),
    });
  });

const decodeModel = (
  operation: TextGenerationOperation,
  modelSelection: ModelSelection,
): Effect.Effect<string, TextGenerationError> =>
  Result.match(decodeOmoModelSlug(modelSelection.model), {
    onFailure: (cause) =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail: `Invalid omo model selection: ${cause.reason}.`,
          cause,
        }),
      ),
    onSuccess: ({ provider, modelId }) => Effect.succeed(`${provider}/${modelId}`),
  });

export const makeOmoTextGeneration = (
  options: MakeOmoTextGenerationOptions = {},
): TextGeneration.TextGeneration["Service"] => {
  const binaryPath = options.binaryPath || "omo";
  const execute = options.execute ?? executeOmoCommand(options.environment);

  const runOmoJson = Effect.fn("OmoTextGeneration.runJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
  }: {
    readonly operation: TextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = yield* decodeModel(operation, modelSelection);
    const runAttempt = (args: ReadonlyArray<string>) =>
      execute({ binaryPath, cwd, args }).pipe(
        Effect.mapError((cause) =>
          normalizeCliError("omo", operation, cause, "Failed to spawn Omo CLI process"),
        ),
        Effect.timeoutOption(OMO_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Omo CLI request timed out." }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );

    let result = yield* runAttempt([
      "-p",
      prompt,
      "--model",
      model,
      "--no-tools",
      "--no-extensions",
    ]);
    if (
      result.exitCode !== 0 &&
      /\bmodel .+ not found\b/i.test(`${result.stderr}\n${result.stdout}`)
    ) {
      // The configured selection rots when the gateway renames models (e.g.
      // apitopia kimi-k3 -> kimi-k3-*-unlocked); every thread title then
      // failed with "Model ... not found". Degrade to the runtime's own
      // default model instead of failing the generation outright.
      yield* Effect.logDebug(
        "omo text generation model unavailable; retrying with runtime default",
        {
          operation,
          model,
        },
      );
      result = yield* runAttempt(["-p", prompt, "--no-tools", "--no-extensions"]);
    }

    if (result.exitCode !== 0) {
      const stderrDetail = result.stderr.trim();
      const stdoutDetail = result.stdout.trim();
      const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
      return yield* new TextGenerationError({
        operation,
        detail:
          detail.length > 0
            ? `Omo CLI command failed: ${detail}`
            : `Omo CLI command failed with code ${result.exitCode}.`,
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchema))(
      extractJsonObject(result.stdout),
    ).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Omo CLI returned invalid JSON output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OmoTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runOmoJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OmoTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      const generated = yield* runOmoJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OmoTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      const generated = yield* runOmoJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OmoTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      const generated = yield* runOmoJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  };
};

export const omoTextGeneration = makeOmoTextGeneration();
