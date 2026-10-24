import {
  OmoSubagentTranscriptError,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  type OmoSubagentTranscriptEvent,
  type OmoSubagentTranscriptPayload,
  type OmoSubagentTranscriptRequest,
  type OmoSubagentOutputResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { readOmoSubagentResult, readOmoSubagentTranscript } from "./omoSubagentArtifacts.ts";

export interface OmoSubagentTranscriptLookup {
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError, never>;
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError, never>;
}

export type OmoSubagentOutputReader = (
  input: OmoSubagentTranscriptRequest,
) => Effect.Effect<OmoSubagentOutputResult>;

const lookupFailure = (detail: string) =>
  new OmoSubagentTranscriptError({ reason: "read_failed", detail });
const MAX_NATIVE_TEXT_CHARS = 32_000;

/** Resolve a thread's project directory and return both pane artifacts in one RPC payload. */
export const serveOmoSubagentTranscript = (
  lookup: OmoSubagentTranscriptLookup,
  input: OmoSubagentTranscriptRequest,
  readOutput?: OmoSubagentOutputReader,
): Effect.Effect<
  OmoSubagentTranscriptPayload,
  OmoSubagentTranscriptError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const thread = yield* lookup
      .getThreadShellById(input.threadId)
      .pipe(Effect.mapError(() => lookupFailure(`Failed to resolve thread ${input.threadId}.`)));
    if (Option.isNone(thread)) {
      return yield* new OmoSubagentTranscriptError({
        reason: "thread_not_found",
        detail: `Thread ${input.threadId} was not found.`,
      });
    }

    const project = yield* lookup
      .getProjectShellById(thread.value.projectId)
      .pipe(
        Effect.mapError(() =>
          lookupFailure(`Failed to resolve project ${thread.value.projectId}.`),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new OmoSubagentTranscriptError({
        reason: "project_not_found",
        detail: `Project ${thread.value.projectId} was not found.`,
      });
    }

    if (readOutput !== undefined) {
      const remote = yield* readOutput(input);
      if (remote.kind === "not_found") {
        return yield* new OmoSubagentTranscriptError({
          reason: "task_not_found",
          detail: "Subagent task was not found in this thread.",
        });
      }
      const payload = remoteTranscriptPayload(remote);
      if (payload !== null) return payload;
    }

    return yield* Effect.all({
      transcript: readOmoSubagentTranscript(project.value.workspaceRoot, input.taskId),
      result: readOmoSubagentResult(project.value.workspaceRoot, input.taskId),
    }).pipe(
      Effect.mapError(
        () =>
          new OmoSubagentTranscriptError({
            reason: "invalid_task_id",
            detail: `Invalid omo subagent task id: ${input.taskId}.`,
          }),
      ),
    );
  });

const remoteTranscriptPayload = (
  output: OmoSubagentOutputResult,
): OmoSubagentTranscriptPayload | null => {
  if (output.kind !== "transcript" && output.kind !== "status") return null;
  const sourceText = output.kind === "transcript" ? output.transcript.trim() : "";
  const parsed = parseFlattenedTranscript(sourceText);
  const result = boundText(output.snapshot.errorMessage ?? output.snapshot.finalResponse ?? "");
  return {
    transcript: {
      events: parsed.events,
      truncated:
        output.kind === "transcript"
          ? output.truncated || sourceText.length > MAX_NATIVE_TEXT_CHARS || parsed.truncatedByBound
          : false,
    },
    result: result.length === 0 ? null : result,
  };
};

const EVENT_PREFIX = /^(assistant|error|tool\[error\]|tool): /;

const parseFlattenedTranscript = (
  sourceText: string,
): { events: OmoSubagentTranscriptEvent[]; truncatedByBound: boolean } => {
  if (sourceText.length === 0) return { events: [], truncatedByBound: false };

  const raw: OmoSubagentTranscriptEvent[] = [];
  let assistantLines: string[] | null = null;

  const flushAssistant = () => {
    if (assistantLines === null) return;
    raw.push({ type: "assistant_message", text: assistantLines.join("\n") });
    assistantLines = null;
  };

  for (const line of sourceText.split(/\r?\n/u)) {
    const match = EVENT_PREFIX.exec(line);
    if (match === null) {
      if (assistantLines === null) assistantLines = [line];
      else assistantLines.push(line);
      continue;
    }
    const prefix = match[1];
    const rest = line.slice(match[0].length);
    if (prefix === "assistant") {
      flushAssistant();
      assistantLines = [rest];
      continue;
    }
    flushAssistant();
    if (prefix === "tool[error]") {
      raw.push({ type: "tool_execution", tool: rest, isError: true });
    } else if (prefix === "tool") {
      raw.push({ type: "tool_execution", tool: rest, isError: false });
    } else {
      raw.push({ type: "unknown", originalType: "error", payload: rest });
    }
  }
  flushAssistant();
  return boundParsedEvents(raw);
};

const boundParsedEvents = (
  events: ReadonlyArray<OmoSubagentTranscriptEvent>,
): { events: OmoSubagentTranscriptEvent[]; truncatedByBound: boolean } => {
  let remaining = MAX_NATIVE_TEXT_CHARS;
  let truncatedByBound = false;
  const bounded: OmoSubagentTranscriptEvent[] = [];
  for (const event of events) {
    if (event.type !== "assistant_message") {
      bounded.push(event);
      continue;
    }
    if (remaining === 0) {
      if (event.text.length > 0) truncatedByBound = true;
      continue;
    }
    const text = boundText(event.text).slice(0, remaining);
    if (text.length < event.text.length) truncatedByBound = true;
    remaining -= text.length;
    bounded.push({ type: "assistant_message", text });
  }
  return { events: bounded, truncatedByBound };
};

const boundText = (value: string): string => value.slice(0, MAX_NATIVE_TEXT_CHARS);
