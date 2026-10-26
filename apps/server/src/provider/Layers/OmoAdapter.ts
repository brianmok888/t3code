import type {
  CanonicalItemType,
  OmoSettings,
  ProviderSendTurnInput,
  ProviderSession,
  RuntimePlanStep,
  ThreadActiveMonitor,
  ThreadDagNodeActivity,
  ThreadDagRun,
  ThreadGoal,
  ThreadSteeringQueuedMessage,
  ThreadSteeringState,
  ThreadSubagentTask,
  UserInputQuestion,
} from "@t3tools/contracts";
import {
  type ThreadTurnDeliveryMode,
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "../omo/omoRuntimeEvents.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { sweepPartialSessionCopies } from "../omo/omoCliSessionCopy.ts";
import {
  ensureOmoSessionDir,
  initializeOmoSessionLayout,
  isPathInsideOmoSessionDir,
  makeOmoSessionFilePathAllocator,
  resolveOmoSessionDir,
} from "../Drivers/OmoSessionLayout.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  decodeOmoModelSlug,
  encodeOmoModelSlug,
  omoImageContentFromBytes,
  omoPermissionPreset,
  type OmoImageContent,
  type OmoModelRef,
} from "../omo/omoMappers.ts";
import {
  decodeOmoInboundRecord,
  extractRole,
  extractStopReason,
  type OmoAssistantMessageEvent,
  type OmoEvent,
  type OmoThinkingLevel,
} from "../omo/omoRpcProtocol.ts";
import { planResumedModelReconciliation } from "../omo/omoResumedModelReconciliation.ts";
import {
  THINKING_LEVEL_OPTION_ID,
  sanitizeThinkingLevelSelection,
} from "../omo/omoThinkingLevels.ts";
import {
  reconcileOmoGoalOnStop,
  resolveOmoGoalFile,
  watchOmoGoal,
} from "../omo/omoGoalProjection.ts";
import { decodeOmoTaskUpdatedSubagents, watchOmoSubagents } from "../omo/omoSubagentProjection.ts";
import {
  decodeOmoDagActivity,
  decodeOmoDagUpdatedRuns,
  mergeOmoDagActivityIntoRuns,
} from "../omo/omoDagProjection.ts";
import { diffOmoDagRunLiveness, omoDagRunLivenessTaskId } from "../omo/omoDagLiveness.ts";
import { diffOmoSubagentLiveness, omoSubagentLivenessTaskId } from "../omo/omoSubagentLiveness.ts";
import {
  detectOmoUlwActive,
  watchOmoWorkActivity,
  type OmoActiveWork,
} from "../omo/omoWorkActivityProjection.ts";
import {
  applyOmoMonitorStateEvent,
  createOmoMonitorProjection,
  hydrateOmoMonitorProjection,
  isOmoMonitorToolName,
  markOmoMonitorEvent,
  projectOmoMonitorToolResult,
  type OmoMonitorProjection,
} from "../omo/omoMonitorProjection.ts";
import {
  decodeOmoMonitorStateEvent,
  OMO_MONITOR_STATE_EVENT_NAME,
} from "../omo/omoMonitorStateEvent.ts";
import { projectOmoAutoCompaction } from "../omo/omoSessionStats.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { makeOmoSharedProcess } from "./OmoSharedProcess.ts";
import {
  normalizeOmoDialogQuestion,
  openOmoSessionHandle,
  registerOmoSessionContext,
  omoDialogResponse,
  type OmoDialogMethod,
  type OmoDialogRequest,
  type OmoSessionHandle,
  OmoRpcSessionState,
  type OmoResumeMismatch,
  type OmoSessionHandleProtocolError,
  type OmoSuccessfulResponse,
} from "./OmoSessionHandle.ts";
import {
  sendOmoTaskCancel,
  sendOmoTaskMessage,
  sendOmoTaskOutput,
  sendSetModel,
} from "./OmoSessionHandleCommands.ts";
import { projectOmoSteeringState, sendOmoPromptSteerAware } from "./OmoSteerSend.ts";
import type {
  OmoSharedProcess,
  OmoSharedProcessError,
  OmoSharedProcessOptions,
} from "../omo/omoRpcConnection.ts";
const PROVIDER = ProviderDriverKind.make("omo");
const OmoResumeCursor = Schema.Struct({
  threadId: ThreadId,
  sessionFile: Schema.String,
  sessionId: Schema.String,
});
type OmoResumeCursor = typeof OmoResumeCursor.Type;
type TurnOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "interrupted" };
type OmoExtensionUiRequest = Extract<OmoEvent, { readonly type: "extension_ui_request" }>;
const RESPONSE_LESS_UI_REQUEST_METHODS = new Set([
  "setStatus",
  "setWidget",
  "notify",
  "setTitle",
  "set_editor_text",
]);
type PendingDialog = {
  readonly requestId: ApprovalRequestId;
  readonly questionId: string;
  readonly nativeId: string;
  readonly method: OmoDialogMethod;
  readonly turnId: TurnId | undefined;
};
type DialogResolvedInput = {
  readonly context: OmoSessionContext;
  readonly pending: PendingDialog;
  readonly answers: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
  readonly bufferWithActiveTurn: boolean;
};
/** Throttle window (ms) for toolcall-args `item.updated` flushes. */
const TOOLCALL_ARGS_FLUSH_INTERVAL_MS = 80;
/**
 * Coalescing window (ms) for `tool_hook_status` → `item.updated` flushes (Lane A).
 * omo emits ~10-20 hook lifecycle statuses per tool call; unthrottled each
 * became a persisted activity that starved the serial ingestion pipeline.
 */
const HOOK_STATUS_FLUSH_INTERVAL_MS = 80;
/** Mutable per-toolCallId hook-status coalescer; mutation follows the stream. */
type HookStatusEntry = {
  lastFlushAt: number | undefined;
  lastStatus: string | undefined;
};
/** Mutable per-contentIndex tool-call arg accumulator; mutation follows the stream. */
type PendingToolCall = {
  readonly itemId: RuntimeItemId;
  partialArgs: string;
  lastFlushAt: number | undefined;
  /** Length of `partialArgs` at the last reported flush (item.started starts at 0). */
  reportedLength: number;
};
/** Mutable assistant aggregation; mutation follows the native message lifecycle. */
type AssistantItemState = {
  readonly textItemId: RuntimeItemId;
  reasoningItemId: RuntimeItemId | undefined;
  text: string;
  reasoning: string;
  readonly pendingToolCalls: Map<number, PendingToolCall>;
};
/** Mutable active-turn protocol state; mutation is the state machine's purpose. */
type ActiveTurn = {
  readonly turnId: TurnId;
  readonly bufferedEvents: ProviderRuntimeEvent[];
  /** Relates terminal assistant tool calls to their later execution events for this turn only. */
  readonly toolCallItemIdsByToolCallId: Map<string, RuntimeItemId>;
  /** Retains incremental todo arguments until their matching execution result arrives. */
  readonly todoArgsByToolCallId: Map<string, Readonly<Record<string, unknown>>>;
  outcome: TurnOutcome;
  provisionalError: string | undefined;
  sawAgentStart: boolean;
  abortIntent: boolean;
  accepted: boolean;
  completionAllowed: boolean;
  completionRaw: unknown | undefined;
  completed: boolean;
  pendingPromptAdmissions: number;
  gateHeld: boolean;
  assistant: AssistantItemState | undefined;
};
/** Mutable session context; fields mirror provider lifecycle transitions. */
type OmoSessionContext = {
  readonly threadId: ThreadId;
  readonly handle: OmoSessionHandle;
  readonly eventQueue: Queue.Queue<OmoEvent>;
  readonly scope: Scope.Closeable;
  readonly sessionFile: string;
  currentModel: OmoModelRef | undefined;
  /** One-shot guard for the model_change entry emitted by a successful T3 set_model. */
  pendingAppliedModelChange: OmoModelRef | undefined;
  lastKnownThinkingLevel: OmoThinkingLevel | undefined;
  readonly sendGate: Semaphore.Semaphore;
  readonly pendingDialogs: Map<ApprovalRequestId, PendingDialog>;
  readonly dialogRequestsByNativeId: Map<string, ApprovalRequestId>;
  readonly hookStatusByToolCallId: Map<string, HookStatusEntry>;
  /** Retains monitor/kill inputs until tool_execution_end supplies the result. */
  readonly toolInputsByToolCallId: Map<
    string,
    { readonly toolName: string; readonly args: unknown }
  >;
  /** Last known complete todo state, retained across turns in this session only. */
  todoPlanState: OmoTodoPlanState | undefined;
  monitorProjection: OmoMonitorProjection;
  readonly monitorWarnings: string[];
  isStreaming: boolean;
  pendingMessageCount: number;
  /** Auto-compaction truth, projected from every get_state refresh (todo 21). */
  autoCompactionEnabled: boolean;
  queuedMessages: ThreadSteeringQueuedMessage[];
  subagents: ReadonlyArray<ThreadSubagentTask>;
  dagRuns: ReadonlyArray<ThreadDagRun>;
  dagActivityByNode: Map<string, ThreadDagNodeActivity>;
  dagRunsDirty: boolean;
  dagRunLiveness: ReadonlyMap<string, string>;
  subagentLiveness: ReadonlyMap<string, string>;
  hasLiveSubagentSnapshot: boolean;
  activeWorks: ReadonlyArray<OmoActiveWork>;
  ulwActive: boolean;
  /** Last goal state this session projected, for the stop-time reconcile. */
  lastProjectedGoal: ThreadGoal | null;
  session: ProviderSession;
  activeTurn: ActiveTurn | null;
  stopped: boolean;
  terminal: boolean;
};
type ThinkingLevelReconciliation =
  | {
      readonly kind: "success";
      readonly response: OmoSuccessfulResponse;
      readonly state: OmoRpcSessionState;
    }
  | {
      readonly kind: "failure";
      readonly error: OmoSharedProcessError | OmoSessionHandleProtocolError;
    }
  | { readonly kind: "invalid"; readonly response: OmoSuccessfulResponse };
type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly raw: unknown;
  readonly method?: string;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly requestId?: RuntimeRequestId;
};
type ItemStartedInput = {
  readonly context: OmoSessionContext;
  readonly active: ActiveTurn;
  readonly itemId: RuntimeItemId;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly raw: unknown;
  readonly detail?: string;
  readonly data?: unknown;
};
type ContentDeltaInput = {
  readonly context: OmoSessionContext;
  readonly active: ActiveTurn;
  readonly itemId: RuntimeItemId;
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly delta: string;
  readonly raw: unknown;
};
type ItemCompletedInput = ItemStartedInput & {
  readonly status: "completed" | "failed";
  readonly detail?: string;
};
export type OmoSharedProcessFactory = (
  options: OmoSharedProcessOptions,
) => Effect.Effect<OmoSharedProcess, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>;
export type OmoAdapterShape = ProviderAdapterShape<ProviderAdapterError> & {
  /** The provider instance's sole RPC supervisor, shared with status probes. */
  readonly sharedProcess: OmoSharedProcess;
  readonly setSessionModel: (
    threadId: ThreadId,
    model: string,
  ) => Effect.Effect<string, ProviderAdapterError>;
};
export type OmoAdapterOptions = {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeSharedProcess?: OmoSharedProcessFactory;
  /** Adapter-owner supplied by the driver so snapshot probes reuse this child. */
  readonly sharedProcess?: OmoSharedProcess;
  readonly beforeProjectSessionEvent?: (threadId: ThreadId, event: OmoEvent) => Effect.Effect<void>;
  readonly onGoalUpdated?: (input: {
    readonly threadId: ThreadId;
    readonly goal: ThreadGoal | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void>;
  readonly onSteeringUpdated?: (input: {
    readonly threadId: ThreadId;
    readonly steering: ThreadSteeringState;
    readonly activeMonitors: readonly ThreadActiveMonitor[];
    readonly subagents: ReadonlyArray<ThreadSubagentTask>;
    readonly dagRuns?: ReadonlyArray<ThreadDagRun>;
    readonly activeWorks: ReadonlyArray<OmoActiveWork>;
    readonly ulwActive: boolean;
    readonly updatedAt: string;
  }) => Effect.Effect<void>;
  /**
   * Boot-scoped nonce mixed into generated turn/item/dialog/event ids.
   * Without it, two adapter instances across server restarts mint identical
   * ids (omo-message-1, omo-turn-1, ...) which collide in the
   * orchestration projection and merge separate turns into one message.
   */
  readonly instanceRunId?: string;
};
const decodeResumeCursor = Schema.decodeUnknownEffect(OmoResumeCursor);
const decodeSessionState = Schema.decodeUnknownResult(OmoRpcSessionState);
const OmoGetEntriesData = Schema.Struct({
  entries: Schema.Array(Schema.Unknown),
  leafId: Schema.NullOr(Schema.String),
});
const OmoHistoryEntry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  message: Schema.optional(Schema.Unknown),
});
type OmoHistoryEntry = typeof OmoHistoryEntry.Type;
type OmoHistoryNode = {
  readonly entry: OmoHistoryEntry;
  readonly raw: unknown;
};

const decodeGetEntriesData = Schema.decodeUnknownEffect(OmoGetEntriesData);
const decodeGetEntriesDataResult = Schema.decodeUnknownResult(OmoGetEntriesData);
const decodeHistoryEntry = Schema.decodeUnknownResult(OmoHistoryEntry);

const assertNever = (value: never): never => {
  throw new Error(`Unhandled omo variant: ${String(value)}`);
};

const nonEmpty = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? fallback : trimmed;
};

const unknownErrorMessage = (value: unknown, fallback: string): string => {
  if (typeof value === "string") return nonEmpty(value, fallback);
  if (value instanceof Error) return nonEmpty(value.message, fallback);
  return fallback;
};

const isOmoRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const omoString = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const OMO_COLLABORATION_TOOL_NAMES = new Set(["task", "agent", "subagent", "sub-agent"]);
const OMO_TODO_OPERATIONS = new Set(["init", "start", "done", "rm", "drop", "append", "view"]);
type OmoTodoOperation = "init" | "start" | "done" | "rm" | "drop" | "append" | "view";
type OmoTodoStatus = "pending" | "in_progress" | "completed" | "abandoned";
declare const omoTodoUnknownStatus: unique symbol;
type OmoTodoUnknownStatus = string & { readonly [omoTodoUnknownStatus]: true };
type OmoTodoTaskStatus = OmoTodoStatus | OmoTodoUnknownStatus;
type OmoTodoTask = { content: string; status: OmoTodoTaskStatus };
type OmoTodoPhase = { name: string; tasks: OmoTodoTask[] };
type OmoTodoPlanState = OmoTodoPhase[];

const runtimePlanStatusByOmoTodoStatus = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
  abandoned: "pending",
} as const satisfies Record<OmoTodoStatus, RuntimePlanStep["status"]>;

function classifyOmoToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "bash") return "command_execution";
  if (normalized === "edit" || normalized === "write" || normalized === "apply_patch") {
    return "file_change";
  }
  if (normalized === "websearch" || normalized === "web_search") return "web_search";
  if (OMO_COLLABORATION_TOOL_NAMES.has(normalized)) return "collab_agent_tool_call";
  return "dynamic_tool_call";
}

function omoPrimaryPatchPath(args: Readonly<Record<string, unknown>>): string | undefined {
  const explicitPath =
    omoString(args, "path") ?? omoString(args, "filePath") ?? omoString(args, "file_path");
  if (explicitPath !== undefined) return explicitPath;
  const patch = omoString(args, "input") ?? omoString(args, "patch");
  const match =
    patch === undefined ? null : /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(patch);
  return match === null || match[1] === undefined ? undefined : match[1].trim();
}

function summarizeOmoToolRequest(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  switch (toolName.toLowerCase()) {
    case "bash":
      return omoString(args, "command");
    case "edit":
    case "write":
      return omoString(args, "path") ?? omoString(args, "filePath") ?? omoString(args, "file_path");
    case "apply_patch":
      return omoPrimaryPatchPath(args);
    case "websearch":
    case "web_search":
      return omoString(args, "query");
    case "webfetch":
      return omoString(args, "url");
    default:
      return undefined;
  }
}

function omoToolRequestDetail(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Readonly<{ readonly detail?: string }> {
  const detail = summarizeOmoToolRequest(toolName, args);
  return detail === undefined ? {} : { detail };
}

function omoToolResultContent(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!isOmoRecord(result)) return undefined;
  const directText = result.text;
  if (typeof directText === "string") return directText;
  if (!Array.isArray(result.content)) return undefined;
  const content = result.content
    .map((block) =>
      isOmoRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : "",
    )
    .join("");
  return content.length > 0 ? content : undefined;
}

function omoToolResultPatch(result: unknown): string | undefined {
  if (!isOmoRecord(result) || !isOmoRecord(result.details)) return undefined;
  return typeof result.details.patch === "string" ? result.details.patch : undefined;
}

function omoBashExitCode(content: string | undefined): number | undefined {
  if (content === undefined) return undefined;
  const match = /Command exited with code (\d+)/.exec(content);
  return match === null ? undefined : Number(match[1]);
}

function normalizeOmoToolResult(
  toolName: string,
  result: unknown,
): Readonly<Record<string, unknown>> {
  const content = omoToolResultContent(result);
  const patch = omoToolResultPatch(result);
  const exitCode = toolName.toLowerCase() === "bash" ? omoBashExitCode(content) : undefined;
  return {
    ...(content === undefined ? {} : { content }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(patch === undefined ? {} : { patch }),
  };
}

function isOmoTodoTool(toolName: string): boolean {
  return toolName.toLowerCase() === "todo";
}

function parseOmoTodoOperation(value: unknown): OmoTodoOperation | undefined {
  return typeof value === "string" && OMO_TODO_OPERATIONS.has(value)
    ? (value as OmoTodoOperation)
    : undefined;
}

function parseOmoTodoStatus(value: unknown): OmoTodoStatus | undefined {
  return value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "abandoned"
    ? value
    : undefined;
}

function parseOmoTodoTaskStatus(value: unknown): OmoTodoTaskStatus | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const status = value.trim();
  return parseOmoTodoStatus(status) ?? (status as OmoTodoUnknownStatus);
}

function cloneOmoTodoPlanState(state: OmoTodoPlanState): OmoTodoPlanState {
  return state.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ ...task })),
  }));
}

function normalizeOmoTodoInProgress(state: OmoTodoPlanState): void {
  const tasks = state.flatMap((phase) => phase.tasks);
  const inProgress = tasks.filter((task) => task.status === "in_progress");
  for (const task of inProgress.slice(1)) task.status = "pending";
  if (inProgress.length > 0) return;
  const firstPending = tasks.find((task) => task.status === "pending");
  if (firstPending !== undefined) firstPending.status = "in_progress";
}

function parseOmoTodoPlanState(value: unknown): OmoTodoPlanState | undefined {
  if (!isOmoRecord(value) || !Array.isArray(value.phases)) return undefined;
  const phases: OmoTodoPlanState = [];
  for (const rawPhase of value.phases) {
    if (!isOmoRecord(rawPhase) || !Array.isArray(rawPhase.tasks)) return undefined;
    const name = omoString(rawPhase, "name");
    if (name === undefined) return undefined;
    const tasks: OmoTodoTask[] = [];
    for (const rawTask of rawPhase.tasks) {
      if (!isOmoRecord(rawTask)) return undefined;
      const content = omoString(rawTask, "content");
      const status = parseOmoTodoTaskStatus(rawTask.status);
      if (content === undefined || status === undefined) return undefined;
      tasks.push({ content, status });
    }
    phases.push({ name, tasks });
  }
  return phases;
}

function parseOmoTodoResultState(result: unknown): OmoTodoPlanState | undefined {
  if (!isOmoRecord(result) || !isOmoRecord(result.details)) return undefined;
  const operation = result.details.op;
  if (operation !== undefined && parseOmoTodoOperation(operation) === undefined) return undefined;
  return parseOmoTodoPlanState(result.details);
}

function hasOmoTodoArgument(args: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, key);
}

function optionalOmoTodoText(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined | null {
  if (!hasOmoTodoArgument(args, key)) return undefined;
  return omoString(args, key) ?? null;
}

function omoTodoPlanSteps(state: OmoTodoPlanState): RuntimePlanStep[] {
  return state.flatMap((phase) =>
    phase.tasks.flatMap((task) => {
      const status = parseOmoTodoStatus(task.status);
      return status === undefined
        ? []
        : [{ step: task.content, status: runtimePlanStatusByOmoTodoStatus[status] }];
    }),
  );
}

function omoTodoTargetTasks(
  state: OmoTodoPlanState,
  args: Readonly<Record<string, unknown>>,
): OmoTodoTask[] | undefined {
  const task = optionalOmoTodoText(args, "task");
  if (task === null) return undefined;
  if (task !== undefined) {
    for (const phase of state) {
      const target = phase.tasks.find((candidate) => candidate.content === task);
      if (target !== undefined) return [target];
    }
    return undefined;
  }
  const phaseName = optionalOmoTodoText(args, "phase");
  if (phaseName === null) return undefined;
  if (phaseName !== undefined) {
    const phase = state.find((candidate) => candidate.name === phaseName);
    return phase?.tasks;
  }
  return state.flatMap((phase) => phase.tasks);
}

function initializeOmoTodoPlan(
  args: Readonly<Record<string, unknown>>,
): OmoTodoPlanState | undefined {
  const initPhase = optionalOmoTodoText(args, "phase");
  if (initPhase === null) return undefined;
  const list = args.list;
  const listEntries = Array.isArray(list)
    ? list
    : list === undefined && Array.isArray(args.items) && args.items.length > 0
      ? [{ phase: initPhase ?? "Tasks", items: args.items }]
      : undefined;
  if (listEntries === undefined) return undefined;
  const state: OmoTodoPlanState = [];
  const phasesByName = new Map<string, OmoTodoPhase>();
  const seenTasks = new Set<string>();
  for (const rawEntry of listEntries) {
    if (!isOmoRecord(rawEntry) || !Array.isArray(rawEntry.items) || rawEntry.items.length === 0) {
      return undefined;
    }
    const name = omoString(rawEntry, "phase");
    if (name === undefined) return undefined;
    let phase = phasesByName.get(name);
    if (phase === undefined) {
      phase = { name, tasks: [] };
      phasesByName.set(name, phase);
      state.push(phase);
    }
    for (const rawItem of rawEntry.items) {
      if (typeof rawItem !== "string" || rawItem.trim().length === 0) return undefined;
      const content = rawItem.trim();
      if (seenTasks.has(content)) continue;
      seenTasks.add(content);
      phase.tasks.push({ content, status: "pending" });
    }
  }
  normalizeOmoTodoInProgress(state);
  return state;
}

function applyOmoTodoOperation(
  previous: OmoTodoPlanState | undefined,
  args: Readonly<Record<string, unknown>>,
): OmoTodoPlanState | undefined {
  const operation = parseOmoTodoOperation(args.op);
  if (operation === undefined) return undefined;
  if (operation === "init") return initializeOmoTodoPlan(args);
  if (previous === undefined) return undefined;
  const state = cloneOmoTodoPlanState(previous);
  switch (operation) {
    case "start": {
      const task = optionalOmoTodoText(args, "task");
      if (task === null || task === undefined) return undefined;
      const target = state
        .flatMap((phase) => phase.tasks)
        .find((candidate) => candidate.content === task);
      if (target === undefined) return undefined;
      for (const candidate of state.flatMap((phase) => phase.tasks)) {
        if (candidate.status === "in_progress" && candidate !== target)
          candidate.status = "pending";
      }
      target.status = "in_progress";
      normalizeOmoTodoInProgress(state);
      return state;
    }
    case "done":
    case "drop": {
      const targets = omoTodoTargetTasks(state, args);
      if (targets === undefined) return undefined;
      for (const task of targets) task.status = operation === "done" ? "completed" : "abandoned";
      normalizeOmoTodoInProgress(state);
      return state;
    }
    case "rm": {
      const task = optionalOmoTodoText(args, "task");
      if (task === null) return undefined;
      if (task !== undefined) {
        for (const phase of state) {
          const index = phase.tasks.findIndex((candidate) => candidate.content === task);
          if (index >= 0) {
            phase.tasks.splice(index, 1);
            normalizeOmoTodoInProgress(state);
            return state;
          }
        }
        return undefined;
      }
      const phaseName = optionalOmoTodoText(args, "phase");
      if (phaseName === null) return undefined;
      if (phaseName !== undefined) {
        const phase = state.find((candidate) => candidate.name === phaseName);
        if (phase === undefined) return undefined;
        phase.tasks = [];
      } else {
        for (const phase of state) phase.tasks = [];
      }
      normalizeOmoTodoInProgress(state);
      return state;
    }
    case "append": {
      if (!Array.isArray(args.items) || args.items.length === 0) return undefined;
      const phaseName = optionalOmoTodoText(args, "phase");
      if (phaseName === null) return undefined;
      const items: string[] = [];
      const seen = new Set<string>();
      for (const rawItem of args.items) {
        if (typeof rawItem !== "string" || rawItem.trim().length === 0) return undefined;
        const content = rawItem.trim();
        if (
          seen.has(content) ||
          state.some((phase) => phase.tasks.some((task) => task.content === content))
        ) {
          return undefined;
        }
        seen.add(content);
        items.push(content);
      }
      const activePhase = state.find((phase) =>
        phase.tasks.some((task) => task.status === "in_progress"),
      );
      const name = phaseName ?? activePhase?.name ?? state[state.length - 1]?.name ?? "Tasks";
      let phase = state.find((candidate) => candidate.name === name);
      if (phase === undefined) {
        phase = { name, tasks: [] };
        state.push(phase);
      }
      for (const content of items) phase.tasks.push({ content, status: "pending" });
      normalizeOmoTodoInProgress(state);
      return state;
    }
    case "view":
      return state;
  }
}

/** `list_sessions` rows, narrowed to what stranded-path recovery needs. */
const OmoListedSessions = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      sessionPath: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  ),
});
type OmoListedSession = (typeof OmoListedSessions.Type)["sessions"][number];
const decodeListedSessions = Schema.decodeUnknownResult(OmoListedSessions);
const decodeOmoListedSessions = (data: unknown): ReadonlyArray<OmoListedSession> => {
  const decoded = decodeListedSessions(data);
  return Result.isSuccess(decoded) ? decoded.success.sessions : [];
};

/** omo's stable rejection when a session file is still reserved by a live session. */
const isOmoSessionPathInUse = (
  error: OmoSharedProcessError | OmoSessionHandleProtocolError | OmoResumeMismatch,
): boolean =>
  error._tag === "OmoSharedProcessRequestFailed" && error.detail === "session_path_in_use";

const runtimeErrorDetail = (
  error: OmoSharedProcessError | OmoSessionHandleProtocolError | OmoResumeMismatch,
): string => {
  switch (error._tag) {
    case "OmoSharedProcessSpawnFailed":
      return `Failed to spawn '${error.binaryPath}'.`;
    case "OmoSharedProcessExited":
      return nonEmpty(
        error.stderrTail,
        `omo exited with code ${error.exitCode === null ? "unknown" : error.exitCode}`,
      );
    case "OmoSharedProcessRequestFailed":
    case "OmoSessionHandleProtocolError":
      return error.detail;
    case "OmoResumeMismatch":
      return `Resume session mismatch: expected '${error.expectedSessionId}' but omo opened '${error.actualSessionId}'. Restore the matching session file or start a new thread.`;
  }
};

const sameModel = (left: OmoModelRef, right: OmoModelRef): boolean =>
  left.provider === right.provider && left.modelId === right.modelId;

const clearTurnToolCallMappings = (active: ActiveTurn): void => {
  // The content-index map belongs to the current assistant message while the
  // toolCall-id map survives through its execution events. Both are turn-scoped.
  active.assistant?.pendingToolCalls.clear();
  active.toolCallItemIdsByToolCallId.clear();
  active.todoArgsByToolCallId.clear();
};

const makeTurnOutcome = (
  active: ActiveTurn,
): { readonly state: "completed" | "failed" | "interrupted"; readonly error?: string } => {
  if (active.abortIntent) return { state: "interrupted" };
  switch (active.outcome.kind) {
    case "none":
      return active.provisionalError === undefined
        ? { state: "completed" }
        : { state: "failed", error: active.provisionalError };
    case "failed":
      return { state: "failed", error: active.outcome.message };
    case "interrupted":
      return { state: "interrupted" };
    default:
      return assertNever(active.outcome);
  }
};

export const makeOmoAdapter = Effect.fn("makeOmoAdapter")(function* (
  settings: OmoSettings,
  options: OmoAdapterOptions = {},
): Effect.fn.Return<
  OmoAdapterShape,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope
  | ServerConfig
> {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("omo");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const adapterScope = yield* Scope.Scope;
  yield* initializeOmoSessionLayout(serverConfig.stateDir).pipe(Effect.orDie);
  // A `*.partial` can only be an adoption copy interrupted between write and
  // rename. It is never a readable session, so clearing it at startup keeps a
  // crashed adoption from leaving debris in this instance's session dir.
  yield* sweepPartialSessionCopies(
    resolveOmoSessionDir(serverConfig.stateDir, boundInstanceId),
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.flatMap((removed) =>
      removed.length === 0
        ? Effect.void
        : Effect.logWarning("omo.session.partial-copies-swept", { removed }),
    ),
  );
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, OmoSessionContext>();
  // One permit per thread over start/stop. omo holds a session-path reservation
  // from the moment `open_session` is accepted until its `close_session` has
  // finished aborting and disposing the runtime, so an unserialized restart
  // reopens the resume cursor's path while the previous close still owns it and
  // omo answers `session_path_in_use`.
  const sessionLifecycleGates = new Map<ThreadId, Semaphore.Semaphore>();
  const withSessionLifecycleGate = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let gate = sessionLifecycleGates.get(threadId);
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(1);
      sessionLifecycleGates.set(threadId, gate);
    }
    return gate.withPermits(1)(effect);
  };
  const maxPendingExtensionEventRoutes = 32;
  const maxPendingExtensionEventsPerRoute = 64;
  const maxClosedExtensionEventRoutes = 128;
  const pendingExtensionEvents = new Map<string, OmoEvent[]>();
  const closedExtensionEventRoutes = new Set<string>();
  // Extension events the routed handler actually projects. An unrouted copy of
  // any of these is buffered until registration; anything else is chatter that
  // even a routed session drops. Keep this the single source for both checks.
  const bufferedExtensionEventNames: ReadonlySet<string> = new Set([
    "omo.task.updated",
    "omo.dag.updated",
    "omo.dag.activity",
  ]);
  const pendingExtensionEventKey = (epoch: number, sessionId: string): string =>
    `${epoch}:${sessionId}`;
  const allocateSessionFile = makeOmoSessionFilePathAllocator();
  const createSharedProcess = options.makeSharedProcess ?? makeOmoSharedProcess;
  const shared =
    options.sharedProcess ??
    (yield* createSharedProcess({
      binaryPath: settings.binaryPath,
      // Never the server's own cwd: that is the deploy location, it moves across
      // restages, and omo's memory auto-identity hashes the child cwd — every
      // relocation re-minted a `server-<hash>` identity and bricked all sessions
      // bound to the previous one. The state dir is the stable per-install anchor.
      cwd: serverConfig.stateDir,
      ...(options.environment === undefined ? {} : { env: options.environment }),
    }).pipe(
      Effect.provideService(Scope.Scope, adapterScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ));
  let nextEventSequence = 1;
  let nextTurnSequence = 1;
  let nextItemSequence = 1;
  let nextDialogSequence = 1;
  const runIdScope =
    options.instanceRunId !== undefined && options.instanceRunId.length > 0
      ? `${options.instanceRunId}-`
      : "";

  const makeEventBase = Effect.fn("OmoAdapter.makeEventBase")(function* (input: EventBaseInput) {
    const eventId = EventId.make(`omo-event-${runIdScope}${nextEventSequence}`);
    nextEventSequence += 1;
    return {
      eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: input.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      raw: {
        source: "omo.rpc" as const,
        ...(input.method === undefined ? {} : { method: input.method }),
        payload: input.raw,
      },
    };
  });

  const offerEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const requireSession = Effect.fn("OmoAdapter.requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (context === undefined || context.stopped || context.terminal) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return context;
  });

  const emitSteeringProjection = Effect.fn("OmoAdapter.emitSteeringProjection")(function* (
    context: OmoSessionContext,
  ) {
    const onSteeringUpdated = options.onSteeringUpdated;
    if (onSteeringUpdated === undefined) return;
    const dagRuns = context.dagRunsDirty ? context.dagRuns : undefined;
    yield* onSteeringUpdated({
      threadId: context.threadId,
      steering: projectOmoSteeringState({
        isStreaming: context.isStreaming,
        pendingMessageCount: context.pendingMessageCount,
        queued: context.queuedMessages,
      }),
      activeMonitors: context.monitorProjection.snapshot(),
      subagents: context.subagents,
      ...(dagRuns === undefined ? {} : { dagRuns }),
      activeWorks: context.activeWorks,
      ulwActive: context.ulwActive,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
    if (dagRuns !== undefined) context.dagRunsDirty = false;
  });

  const logMonitorWarnings = Effect.fn("OmoAdapter.logMonitorWarnings")(function* (
    context: OmoSessionContext,
  ) {
    for (const warning of context.monitorWarnings.splice(0)) {
      yield* Effect.logWarning("omo monitor projection skipped malformed lifecycle event", {
        provider: PROVIDER,
        threadId: context.threadId,
        warning,
      });
    }
  });

  const hydrateMonitorProjection = Effect.fn("OmoAdapter.hydrateMonitorProjection")(function* (
    context: OmoSessionContext,
  ) {
    const response = yield* Effect.result(context.handle.send({ type: "get_entries" }));
    if (Result.isFailure(response)) {
      yield* Effect.logWarning("omo monitor projection hydration failed", {
        provider: PROVIDER,
        threadId: context.threadId,
        cause: response.failure,
      });
      return;
    }
    const decoded = decodeGetEntriesDataResult(response.success.data);
    if (Result.isFailure(decoded)) {
      yield* Effect.logWarning("omo monitor projection hydration returned invalid entries", {
        provider: PROVIDER,
        threadId: context.threadId,
      });
      return;
    }
    context.monitorProjection = hydrateOmoMonitorProjection(
      decoded.success.entries,
      decoded.success.leafId,
      (warning) => context.monitorWarnings.push(warning),
    );
    context.ulwActive = detectOmoUlwActive(decoded.success.entries);
    yield* logMonitorWarnings(context);
  });

  const applySteeringState = Effect.fn("OmoAdapter.applySteeringState")(function* (
    context: OmoSessionContext,
    state: OmoRpcSessionState,
  ) {
    context.isStreaming = state.isStreaming;
    context.pendingMessageCount = state.pendingMessageCount;
    // omo owns the auto-compaction toggle: the refreshed session state is the
    // only source for it, never the value a set_auto_compaction request asked for.
    context.autoCompactionEnabled = projectOmoAutoCompaction(state);
    // omo's count is the authority: the optimistic queue may hold entries omo
    // has already consumed, so trim the oldest extras down to the reported
    // count on every sync instead of only clearing at zero.
    if (state.pendingMessageCount < context.queuedMessages.length) {
      context.queuedMessages = context.queuedMessages.slice(
        context.queuedMessages.length - state.pendingMessageCount,
      );
    }
    yield* emitSteeringProjection(context);
  });

  /**
   * Optimistic queue push. A resend of the same text in the same mode is the
   * same pending message from omo's perspective (queue_update would replace the
   * whole list with one entry), so pushing it twice is the observed duplicate.
   */
  const queueSteeredMessage = (
    context: OmoSessionContext,
    entry: ThreadSteeringQueuedMessage,
  ): void => {
    const alreadyQueued = context.queuedMessages.some(
      (queued) => queued.text === entry.text && queued.mode === entry.mode,
    );
    if (alreadyQueued) return;
    context.queuedMessages.push(entry);
  };

  const releaseTurnGate = Effect.fn("OmoAdapter.releaseTurnGate")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
  ) {
    if (!active.gateHeld) return;
    active.gateHeld = false;
    yield* context.sendGate.release(1);
  });

  const publishTurnEvent = (
    context: OmoSessionContext,
    active: ActiveTurn,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> => {
    if (context.activeTurn !== active || active.completed) return Effect.void;
    if (active.accepted) return offerEvent(event);
    return Effect.sync(() => active.bufferedEvents.push(event)).pipe(Effect.asVoid);
  };

  const makeWarningEvent = Effect.fn("OmoAdapter.makeWarningEvent")(function* (
    context: OmoSessionContext,
    message: string,
    raw: unknown,
    severity: "info" | "warning" | "error" = "warning",
  ) {
    const active = context.activeTurn;
    return {
      ...(yield* makeEventBase({
        threadId: context.threadId,
        raw,
        ...(active === null ? {} : { turnId: active.turnId }),
      })),
      type: "runtime.warning",
      payload: { message: nonEmpty(message, "omo runtime warning"), severity },
    } satisfies ProviderRuntimeEvent;
  });

  const emitWarning = Effect.fn("OmoAdapter.emitWarning")(function* (
    context: OmoSessionContext,
    message: string,
    raw: unknown,
    severity: "info" | "warning" | "error" = "warning",
  ) {
    const event = yield* makeWarningEvent(context, message, raw, severity);
    const active = context.activeTurn;
    if (active === null) {
      yield* offerEvent(event);
      return;
    }
    yield* publishTurnEvent(context, active, event);
  });

  const clearPendingDialog = (
    context: OmoSessionContext,
    requestId: ApprovalRequestId,
  ): PendingDialog | undefined => {
    const pending = context.pendingDialogs.get(requestId as ApprovalRequestId);
    if (pending === undefined) return undefined;
    context.pendingDialogs.delete(requestId);
    context.dialogRequestsByNativeId.delete(pending.nativeId);
    return pending;
  };

  const emitDialogResolved = Effect.fn("OmoAdapter.emitDialogResolved")(function* (
    input: DialogResolvedInput,
  ) {
    const event = {
      ...(yield* makeEventBase({
        threadId: input.context.threadId,
        requestId: RuntimeRequestId.make(input.pending.requestId),
        ...(input.pending.turnId === undefined ? {} : { turnId: input.pending.turnId }),
        raw: input.raw,
        method: "extension_ui_response",
      })),
      type: "user-input.resolved",
      payload: { answers: input.answers },
    } satisfies ProviderRuntimeEvent;
    const active = input.context.activeTurn;
    if (input.bufferWithActiveTurn && active !== null && input.pending.turnId === active.turnId) {
      yield* publishTurnEvent(input.context, active, event);
      return;
    }
    yield* offerEvent(event);
  });

  const expireDialog = Effect.fn("OmoAdapter.expireDialog")(function* (
    context: OmoSessionContext,
    requestId: ApprovalRequestId,
    raw: unknown,
  ) {
    const pending = clearPendingDialog(context, requestId);
    if (pending === undefined) return;
    yield* emitDialogResolved({
      context,
      pending,
      answers: {},
      raw,
      bufferWithActiveTurn: true,
    });
    yield* emitWarning(context, "omo dialog timed out", raw);
  });

  const resolvePendingDialogs = Effect.fn("OmoAdapter.resolvePendingDialogs")(function* (
    context: OmoSessionContext,
    raw: unknown,
  ) {
    const pendingDialogs = Array.from(context.pendingDialogs.values());
    context.pendingDialogs.clear();
    context.dialogRequestsByNativeId.clear();
    yield* Effect.forEach(
      pendingDialogs,
      (pending) =>
        emitDialogResolved({
          context,
          pending,
          answers: {},
          raw,
          bufferWithActiveTurn: false,
        }),
      { concurrency: 1, discard: true },
    );
  });

  const cancelUnsupportedDialog = Effect.fn("OmoAdapter.cancelUnsupportedDialog")(function* (
    context: OmoSessionContext,
    event: OmoExtensionUiRequest,
    warning: string,
  ) {
    yield* context.handle
      .notify({ type: "extension_ui_response", id: event.id, cancelled: true })
      .pipe(
        Effect.catch((error) =>
          emitWarning(context, "omo failed to cancel an unsupported dialog", {
            event,
            error,
          }),
        ),
      );
    yield* emitWarning(context, warning, event);
  });

  const registerDialog = Effect.fn("OmoAdapter.registerDialog")(function* (
    context: OmoSessionContext,
    event: OmoDialogRequest,
    question: UserInputQuestion,
  ) {
    const requestId = ApprovalRequestId.make(question.id);
    const pending: PendingDialog = {
      requestId,
      questionId: question.id,
      nativeId: event.id,
      method: event.method,
      turnId: context.activeTurn?.turnId,
    };
    context.pendingDialogs.set(requestId, pending);
    context.dialogRequestsByNativeId.set(event.id, requestId);
    const requested = {
      ...(yield* makeEventBase({
        threadId: context.threadId,
        requestId: RuntimeRequestId.make(requestId),
        ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
        raw: event,
        method: event.method,
      })),
      type: "user-input.requested",
      payload: { questions: [question] },
    } satisfies ProviderRuntimeEvent;
    const active = context.activeTurn;
    if (active !== null && pending.turnId === active.turnId) {
      yield* publishTurnEvent(context, active, requested);
    } else {
      yield* offerEvent(requested);
    }
    if (event.timeout !== undefined) {
      yield* Effect.sleep(Duration.millis(Math.max(0, event.timeout) + 2_000)).pipe(
        Effect.andThen(
          expireDialog(context, requestId, {
            type: "extension_ui_timeout",
            nativeRequestId: event.id,
          }),
        ),
        Effect.forkIn(context.scope),
      );
    }
  });

  const handleExtensionUiRequest = Effect.fn("OmoAdapter.handleExtensionUiRequest")(function* (
    context: OmoSessionContext,
    event: OmoExtensionUiRequest,
  ) {
    switch (event.method) {
      case "select":
      case "confirm":
      case "input": {
        const requestId = ApprovalRequestId.make(`omo-dialog-${runIdScope}${nextDialogSequence}`);
        nextDialogSequence += 1;
        const question = normalizeOmoDialogQuestion(requestId, event);
        if (question === undefined) {
          yield* cancelUnsupportedDialog(
            context,
            event,
            "omo select dialog had no usable options and was cancelled",
          );
          return;
        }
        yield* registerDialog(context, event, question);
        return;
      }
      case "editor":
        yield* cancelUnsupportedDialog(
          context,
          event,
          "omo editor dialog is unsupported and was cancelled",
        );
        return;
      case "custom_unsupported":
        yield* cancelUnsupportedDialog(
          context,
          event,
          "omo custom UI is unsupported and was cancelled",
        );
        return;
      case "notify":
        yield* emitWarning(
          context,
          nonEmpty(event.message, "Omo notification"),
          event,
          event.notifyType ?? "warning",
        );
        return;
      case "setStatus":
      case "setWidget":
      case "setTitle":
      case "set_editor_text":
        yield* Effect.logDebug("omo.extension_ui.update.ignored", {
          provider: PROVIDER,
          threadId: context.threadId,
          nativeRequestId: event.id,
          method: event.method,
        });
        return;
      default:
        return assertNever(event);
    }
  });

  const finishTurn = Effect.fn("OmoAdapter.finishTurn")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
    raw: unknown,
  ) {
    if (context.activeTurn !== active || active.completed) return;
    active.completed = true;
    const outcome = makeTurnOutcome(active);
    yield* offerEvent({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId: active.turnId,
        raw,
      })),
      type: "turn.completed",
      payload: {
        state: outcome.state,
        ...(outcome.error === undefined
          ? {}
          : { errorMessage: nonEmpty(outcome.error, "omo turn failed") }),
      },
    } satisfies ProviderRuntimeEvent);
    context.activeTurn = null;
    // BLOCKER 3: sweep per-turn correlation/coalescing state at turn termination
    // so interrupted tool calls can never affect a later turn in this session.
    clearTurnToolCallMappings(active);
    context.hookStatusByToolCallId.clear();
    context.toolInputsByToolCallId.clear();
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* releaseTurnGate(context, active);
  });

  const emitItemStarted = Effect.fn("OmoAdapter.emitItemStarted")(function* (
    input: ItemStartedInput,
  ) {
    yield* publishTurnEvent(input.context, input.active, {
      ...(yield* makeEventBase({
        threadId: input.context.threadId,
        turnId: input.active.turnId,
        itemId: input.itemId,
        raw: input.raw,
      })),
      type: "item.started",
      payload: {
        itemType: input.itemType,
        status: "inProgress",
        title: nonEmpty(input.title, "Omo item"),
        ...(input.detail === undefined || input.detail.trim().length === 0
          ? {}
          : { detail: input.detail.trim() }),
        ...(input.data === undefined ? {} : { data: input.data }),
      },
    } satisfies ProviderRuntimeEvent);
  });

  const emitContentDelta = Effect.fn("OmoAdapter.emitContentDelta")(function* (
    input: ContentDeltaInput,
  ) {
    if (input.delta.length === 0) return;
    yield* publishTurnEvent(input.context, input.active, {
      ...(yield* makeEventBase({
        threadId: input.context.threadId,
        turnId: input.active.turnId,
        itemId: input.itemId,
        raw: input.raw,
      })),
      type: "content.delta",
      payload: { streamKind: input.streamKind, delta: input.delta },
    } satisfies ProviderRuntimeEvent);
  });

  const emitItemCompleted = Effect.fn("OmoAdapter.emitItemCompleted")(function* (
    input: ItemCompletedInput,
  ) {
    yield* publishTurnEvent(input.context, input.active, {
      ...(yield* makeEventBase({
        threadId: input.context.threadId,
        turnId: input.active.turnId,
        itemId: input.itemId,
        raw: input.raw,
      })),
      type: "item.completed",
      payload: {
        itemType: input.itemType,
        status: input.status,
        title: nonEmpty(input.title, "Omo item"),
        ...(input.detail === undefined || input.detail.trim().length === 0
          ? {}
          : { detail: input.detail.trim() }),
        ...(input.data === undefined ? {} : { data: input.data }),
      },
    } satisfies ProviderRuntimeEvent);
  });

  const emitTodoPlanUpdated = Effect.fn("OmoAdapter.emitTodoPlanUpdated")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
    raw: unknown,
  ) {
    const state = context.todoPlanState;
    if (state === undefined) return;
    yield* publishTurnEvent(context, active, {
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId: active.turnId,
        raw,
      })),
      type: "turn.plan.updated",
      payload: { plan: omoTodoPlanSteps(state) },
    } satisfies ProviderRuntimeEvent);
  });

  const handleAssistantUpdate = Effect.fn("OmoAdapter.handleAssistantUpdate")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
    event: Extract<OmoEvent, { readonly type: "message_update" }>,
  ) {
    const assistant = active.assistant;
    if (assistant === undefined) return;
    const update: OmoAssistantMessageEvent = event.assistantMessageEvent;
    switch (update.type) {
      case "text_delta":
        assistant.text += update.delta;
        yield* emitContentDelta({
          context,
          active,
          itemId: assistant.textItemId,
          streamKind: "assistant_text",
          delta: update.delta,
          raw: event,
        });
        return;
      case "thinking_start":
      case "thinking_delta": {
        if (assistant.reasoningItemId === undefined) {
          assistant.reasoningItemId = RuntimeItemId.make(`${assistant.textItemId}-reasoning`);
          yield* emitItemStarted({
            context,
            active,
            itemId: assistant.reasoningItemId,
            itemType: "reasoning",
            title: "Reasoning",
            raw: event,
          });
        }
        if (update.type === "thinking_start") {
          return;
        }
        assistant.reasoning += update.delta;
        yield* emitContentDelta({
          context,
          active,
          itemId: assistant.reasoningItemId,
          streamKind: "reasoning_text",
          delta: update.delta,
          raw: event,
        });
        return;
      }
      case "error":
        active.provisionalError = unknownErrorMessage(update.error, "omo assistant message failed");
        return;
      case "done":
        return;
      case "text_start":
      case "text_end":
      case "thinking_end":
        return;
      case "toolcall_start": {
        const itemId = RuntimeItemId.make(`omo-toolcall-${runIdScope}${nextItemSequence}`);
        nextItemSequence += 1;
        assistant.pendingToolCalls.set(update.contentIndex, {
          itemId,
          partialArgs: "",
          lastFlushAt: undefined,
          reportedLength: 0,
        });
        yield* emitItemStarted({
          context,
          active,
          itemId,
          itemType: classifyOmoToolItemType(""),
          title: "Preparing tool call",
          raw: event,
          data: { partialArgs: "" },
        });
        return;
      }
      case "toolcall_delta": {
        const pending = assistant.pendingToolCalls.get(update.contentIndex);
        if (pending === undefined) return;
        pending.partialArgs += update.delta;
        // Empty/no-growth deltas never consume the throttle window: only consider
        // flushing when args actually grew since the last reported flush.
        if (pending.partialArgs.length <= pending.reportedLength) return;
        const now = yield* Clock.currentTimeMillis;
        if (
          pending.lastFlushAt === undefined ||
          now - pending.lastFlushAt >= TOOLCALL_ARGS_FLUSH_INTERVAL_MS
        ) {
          pending.lastFlushAt = now;
          pending.reportedLength = pending.partialArgs.length;
          yield* publishTurnEvent(context, active, {
            ...(yield* makeEventBase({
              threadId: context.threadId,
              turnId: active.turnId,
              itemId: pending.itemId,
              raw: event,
            })),
            type: "item.updated",
            payload: {
              itemType: classifyOmoToolItemType(""),
              status: "inProgress",
              title: "Preparing tool call",
              data: { partialArgs: pending.partialArgs },
            },
          } satisfies ProviderRuntimeEvent);
        }
        return;
      }
      case "toolcall_end": {
        const pending = assistant.pendingToolCalls.get(update.contentIndex);
        if (pending === undefined) return;
        assistant.pendingToolCalls.delete(update.contentIndex);
        // Flush any unreported growth before completion so the full args are visible.
        if (pending.partialArgs.length > pending.reportedLength) {
          pending.reportedLength = pending.partialArgs.length;
          yield* publishTurnEvent(context, active, {
            ...(yield* makeEventBase({
              threadId: context.threadId,
              turnId: active.turnId,
              itemId: pending.itemId,
              raw: event,
            })),
            type: "item.updated",
            payload: {
              itemType: classifyOmoToolItemType(""),
              status: "inProgress",
              title: "Preparing tool call",
              data: { partialArgs: pending.partialArgs },
            },
          } satisfies ProviderRuntimeEvent);
        }
        const args = update.toolCall.arguments;
        const input = isOmoRecord(args) ? args : undefined;
        active.toolCallItemIdsByToolCallId.set(update.toolCall.id, pending.itemId);
        context.toolInputsByToolCallId.set(update.toolCall.id, {
          toolName: update.toolCall.name,
          args,
        });
        if (isOmoTodoTool(update.toolCall.name) && input !== undefined) {
          active.todoArgsByToolCallId.set(update.toolCall.id, input);
        }
        // A toolcall only describes the pending invocation. Keep this item live
        // for its matching execution result instead of minting a second row.
        yield* publishTurnEvent(context, active, {
          ...(yield* makeEventBase({
            threadId: context.threadId,
            turnId: active.turnId,
            itemId: pending.itemId,
            raw: event,
          })),
          type: "item.updated",
          payload: {
            itemType: classifyOmoToolItemType(update.toolCall.name),
            status: "inProgress",
            title: nonEmpty(update.toolCall.name, "Omo tool"),
            ...(input === undefined ? {} : omoToolRequestDetail(update.toolCall.name, input)),
            data: {
              toolName: update.toolCall.name,
              args,
              ...(input === undefined ? {} : { input }),
              partialArgs: pending.partialArgs,
            },
          },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "unknown":
        yield* emitWarning(
          context,
          `omo emitted an unknown assistant event '${update.eventType}'`,
          event,
        );
        return;
      default:
        return assertNever(update);
    }
  });

  const handleMessageStart = Effect.fn("OmoAdapter.handleMessageStart")(function* (
    context: OmoSessionContext,
    event: Extract<OmoEvent, { readonly type: "message_start" }>,
  ) {
    const active = context.activeTurn;
    if (active === null || extractRole(event.message) !== "assistant") return;
    const itemId = RuntimeItemId.make(`omo-message-${runIdScope}${nextItemSequence}`);
    nextItemSequence += 1;
    active.assistant = {
      textItemId: itemId,
      reasoningItemId: undefined,
      text: "",
      reasoning: "",
      pendingToolCalls: new Map(),
    };
    yield* emitItemStarted({
      context,
      active,
      itemId,
      itemType: "assistant_message",
      title: "Assistant message",
      raw: event,
    });
  });

  const handleMessageEnd = Effect.fn("OmoAdapter.handleMessageEnd")(function* (
    context: OmoSessionContext,
    event: Extract<OmoEvent, { readonly type: "message_end" }>,
  ) {
    const active = context.activeTurn;
    if (active === null || extractRole(event.message) !== "assistant") return;
    const stop = extractStopReason(event.message);
    if (stop.stopReason === "error") {
      active.provisionalError = nonEmpty(stop.errorMessage, "omo assistant message failed");
    } else if (stop.stopReason === "aborted") {
      active.outcome = { kind: "interrupted" };
    }
    const assistant = active.assistant;
    if (assistant === undefined) return;
    const failed = stop.stopReason === "error" || stop.stopReason === "aborted";
    yield* emitItemCompleted({
      context,
      active,
      itemId: assistant.textItemId,
      itemType: "assistant_message",
      status: failed ? "failed" : "completed",
      title: "Assistant message",
      detail: assistant.text,
      raw: event,
    });
    if (assistant.reasoningItemId !== undefined) {
      yield* emitItemCompleted({
        context,
        active,
        itemId: assistant.reasoningItemId,
        itemType: "reasoning",
        status: failed ? "failed" : "completed",
        title: "Reasoning",
        raw: event,
      });
    }
    active.assistant = undefined;
  });

  const handleToolEvent = Effect.fn("OmoAdapter.handleToolEvent")(function* (
    context: OmoSessionContext,
    event: Extract<
      OmoEvent,
      {
        readonly type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
      }
    >,
  ) {
    // BLOCKER 3: the per-toolCallId hook-status entry must be cleared on
    // tool_execution_end REGARDLESS of turn state — a late end arriving after
    // bounded-abort local completion (activeTurn is null) must still clean up.
    // Carried onto the completion activity below: the web parses tool input from
    // `data.args`, and without it a completed monitor row loses its description
    // and unmounts. The cache entry is consumed here, so capture it first.
    let completedToolArgs: unknown = undefined;
    if (event.type === "tool_execution_end") {
      context.hookStatusByToolCallId.delete(event.toolCallId);
      const toolInput = context.toolInputsByToolCallId.get(event.toolCallId);
      completedToolArgs = toolInput?.args;
      context.toolInputsByToolCallId.delete(event.toolCallId);
      const changed = projectOmoMonitorToolResult(context.monitorProjection, {
        toolName: event.toolName,
        args: toolInput?.args,
        result: event.result,
        isError: event.isError,
        occurredAtMs: yield* Clock.currentTimeMillis,
      });
      yield* logMonitorWarnings(context);
      if (changed) yield* emitSteeringProjection(context);
    }
    const active = context.activeTurn;
    if (active === null) return;
    // Out-of-order, post-restart, and legacy execution events have no assistant
    // correlation; retain the established fallback id so they still render.
    const itemId =
      active.toolCallItemIdsByToolCallId.get(event.toolCallId) ??
      RuntimeItemId.make(`omo-tool-${event.toolCallId}`);
    switch (event.type) {
      case "tool_execution_start": {
        context.toolInputsByToolCallId.set(event.toolCallId, {
          toolName: event.toolName,
          args: event.args,
        });
        const input = isOmoRecord(event.args) ? event.args : undefined;
        if (isOmoTodoTool(event.toolName) && input !== undefined) {
          active.todoArgsByToolCallId.set(event.toolCallId, input);
        }
        yield* emitItemStarted({
          context,
          active,
          itemId,
          itemType: classifyOmoToolItemType(event.toolName),
          title: event.toolName,
          raw: event,
          ...(input === undefined ? {} : omoToolRequestDetail(event.toolName, input)),
          data: {
            toolName: event.toolName,
            args: event.args,
            ...(input === undefined ? {} : { input }),
          },
        });
        return;
      }
      case "tool_execution_update": {
        const input = isOmoRecord(event.args) ? event.args : undefined;
        if (isOmoTodoTool(event.toolName) && input !== undefined) {
          active.todoArgsByToolCallId.set(event.toolCallId, input);
        }
        yield* publishTurnEvent(context, active, {
          ...(yield* makeEventBase({
            threadId: context.threadId,
            turnId: active.turnId,
            itemId,
            raw: event,
          })),
          type: "item.updated",
          payload: {
            itemType: classifyOmoToolItemType(event.toolName),
            status: "inProgress",
            title: nonEmpty(event.toolName, "Omo tool"),
            ...(input === undefined ? {} : omoToolRequestDetail(event.toolName, input)),
            data: {
              toolName: event.toolName,
              args: event.args,
              ...(input === undefined ? {} : { input }),
              partialResult: event.partialResult,
            },
          },
        } satisfies ProviderRuntimeEvent);
        return;
      }
      case "tool_execution_end": {
        const todoArgs = active.todoArgsByToolCallId.get(event.toolCallId);
        active.todoArgsByToolCallId.delete(event.toolCallId);
        const todoState = (() => {
          if (event.isError || !isOmoTodoTool(event.toolName)) return undefined;
          const resultState = parseOmoTodoResultState(event.result);
          const hasUnknownOperation =
            todoArgs !== undefined && parseOmoTodoOperation(todoArgs.op) === undefined;
          if (hasUnknownOperation) return undefined;
          return (
            resultState ??
            (todoArgs === undefined
              ? undefined
              : applyOmoTodoOperation(context.todoPlanState, todoArgs))
          );
        })();
        yield* emitItemCompleted({
          context,
          active,
          itemId,
          itemType: classifyOmoToolItemType(event.toolName),
          status: event.isError ? "failed" : "completed",
          title: event.toolName,
          raw: event,
          data: {
            toolName: event.toolName,
            isError: event.isError,
            // The web parses tool input from `data.input` (toolInputParsing.withInput);
            // `args` mirrors the start/update payload shape, which carries both.
            ...(isOmoMonitorToolName(event.toolName) && completedToolArgs !== undefined
              ? {
                  args: completedToolArgs,
                  ...(isOmoRecord(completedToolArgs) ? { input: completedToolArgs } : {}),
                }
              : {}),
            ...(todoArgs === undefined ? {} : { input: todoArgs }),
            ...(todoState === undefined
              ? {}
              : { todoState: { phases: cloneOmoTodoPlanState(todoState) } }),
            rawOutput: normalizeOmoToolResult(event.toolName, event.result),
          },
        });
        if (todoState !== undefined) {
          context.todoPlanState = todoState;
          yield* emitTodoPlanUpdated(context, active, event);
        }
        return;
      }
      default:
        return assertNever(event);
    }
  });

  const updateObservedSessionModel = Effect.fn("OmoAdapter.updateObservedSessionModel")(function* (
    context: OmoSessionContext,
    selector: string,
  ) {
    const decoded = decodeOmoModelSlug(selector);
    if (Result.isFailure(decoded)) {
      yield* Effect.logDebug("omo.runtime.model_selector.invalid", {
        threadId: context.threadId,
        selector,
        reason: decoded.failure.reason,
      });
      return false;
    }
    context.currentModel = decoded.success;
    context.session = {
      ...context.session,
      model: encodeOmoModelSlug(decoded.success),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    return true;
  });

  const emitModelRerouted = Effect.fn("OmoAdapter.emitModelRerouted")(function* (
    context: OmoSessionContext,
    raw: unknown,
    payload: Extract<ProviderRuntimeEvent, { readonly type: "model.rerouted" }>["payload"],
  ) {
    yield* offerEvent({
      ...(yield* makeEventBase({ threadId: context.threadId, raw })),
      type: "model.rerouted",
      payload,
    } satisfies ProviderRuntimeEvent);
  });

  // Senpi also works without a desktop-initiated turn: goal-continuation
  // wakes, memory reflection, and compaction all stream agent activity while
  // `context.activeTurn` is null. Dropping that activity made the session look
  // idle, so a user poke took the idle path and queued invisibly behind the
  // parked loop (observed live: a "Status?" prompt vanished for 91s until a
  // second message interrupted). Adopt the activity into a synthesized
  // external turn instead: the work stays visible, the session reports
  // running, and mid-turn submits steer it like any other turn.
  const ensureExternalTurn = Effect.fn("OmoAdapter.ensureExternalTurn")(function* (
    context: OmoSessionContext,
    raw: unknown,
  ) {
    if (context.activeTurn !== null || context.terminal) return;
    const turnId = TurnId.make(`omo-external-${runIdScope}${nextTurnSequence}`);
    nextTurnSequence += 1;
    const active: ActiveTurn = {
      turnId,
      bufferedEvents: [],
      toolCallItemIdsByToolCallId: new Map(),
      todoArgsByToolCallId: new Map(),
      outcome: { kind: "none" },
      provisionalError: undefined,
      sawAgentStart: true,
      abortIntent: false,
      accepted: true,
      completionAllowed: true,
      completionRaw: undefined,
      completed: false,
      pendingPromptAdmissions: 0,
      gateHeld: false,
      assistant: undefined,
    };
    context.activeTurn = active;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* offerEvent({
      ...(yield* makeEventBase({ threadId: context.threadId, turnId, raw })),
      type: "turn.started",
      payload:
        context.currentModel === undefined
          ? {}
          : { model: encodeOmoModelSlug(context.currentModel) },
    } satisfies ProviderRuntimeEvent);
  });

  const handleRuntimeEvent = Effect.fn("OmoAdapter.handleRuntimeEvent")(function* (
    context: OmoSessionContext,
    event: OmoEvent,
  ) {
    const active = context.activeTurn;
    switch (event.type) {
      case "agent_start":
        if (active === null) {
          yield* ensureExternalTurn(context, event);
        } else {
          active.sawAgentStart = true;
        }
        context.isStreaming = true;
        yield* emitSteeringProjection(context);
        return;
      case "agent_end":
      case "turn_end":
        context.isStreaming = false;
        yield* emitSteeringProjection(context);
        return;
      case "turn_start":
        if (active === null) yield* ensureExternalTurn(context, event);
        context.isStreaming = true;
        yield* emitSteeringProjection(context);
        return;
      case "message_start":
        if (active === null && extractRole(event.message) === "assistant") {
          yield* ensureExternalTurn(context, event);
        }
        yield* handleMessageStart(context, event);
        return;
      case "message_update":
        if (active !== null) yield* handleAssistantUpdate(context, active, event);
        return;
      case "message_end":
        yield* handleMessageEnd(context, event);
        return;
      case "tool_execution_start":
        if (active === null) yield* ensureExternalTurn(context, event);
        yield* handleToolEvent(context, event);
        return;
      case "tool_execution_update":
      case "tool_execution_end":
        yield* handleToolEvent(context, event);
        return;
      case "tool_hook_status": {
        if (active === null) return;
        if (event.toolCallId === undefined) return;
        const status = event.statusMessage ?? event.phase;
        const entry = context.hookStatusByToolCallId.get(event.toolCallId);
        // Dedupe consecutive identical statuses: omo emits ~10-20 per tool call.
        if (entry !== undefined && entry.lastStatus === status) return;
        const now = yield* Clock.currentTimeMillis;
        // Throttle: only flush when no prior flush or >=80ms elapsed since the last.
        if (
          entry !== undefined &&
          entry.lastFlushAt !== undefined &&
          now - entry.lastFlushAt < HOOK_STATUS_FLUSH_INTERVAL_MS
        )
          return;
        const itemId =
          active.toolCallItemIdsByToolCallId.get(event.toolCallId) ??
          RuntimeItemId.make(`omo-tool-${event.toolCallId}`);
        yield* publishTurnEvent(context, active, {
          ...(yield* makeEventBase({
            threadId: context.threadId,
            turnId: active.turnId,
            itemId,
            raw: event,
          })),
          type: "item.updated",
          payload: {
            itemType: classifyOmoToolItemType(event.toolName),
            status: "inProgress",
            title: event.toolName,
            data: { hookStatus: status },
          },
        } satisfies ProviderRuntimeEvent);
        context.hookStatusByToolCallId.set(event.toolCallId, {
          lastFlushAt: now,
          lastStatus: status,
        });
        return;
      }
      case "auto_retry_start":
        yield* emitWarning(
          context,
          `OmO retrying (attempt ${event.attempt}/${event.maxAttempts})`,
          event,
        );
        return;
      case "auto_retry_end":
        if (active === null) return;
        if (event.success) {
          active.provisionalError = undefined;
        } else {
          active.outcome = {
            kind: "failed",
            message: nonEmpty(event.finalError, "OmO retry failed"),
          };
        }
        return;
      case "continuation_error":
        if (active !== null) {
          active.outcome = {
            kind: "failed",
            message: nonEmpty(event.errorMessage, "omo continuation failed"),
          };
        }
        return;
      case "agent_settled":
        context.isStreaming = false;
        yield* emitSteeringProjection(context);
        if (active === null || active.completed) return;
        active.completionRaw = event;
        if (active.completionAllowed && active.pendingPromptAdmissions === 0) {
          yield* finishCompletionRaw(context, active);
        }
        return;
      case "session_info_changed":
        if (event.name === undefined || event.name.trim().length === 0) return;
        yield* offerEvent({
          ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
          type: "thread.metadata.updated",
          payload: { name: event.name.trim() },
        } satisfies ProviderRuntimeEvent);
        return;
      case "thinking_level_changed":
        context.lastKnownThinkingLevel = sanitizeThinkingLevelSelection(event.level);
        yield* emitModelRerouted(context, event, {
          thinkingLevel: event.level,
          reasonClass: "thinking-level",
        });
        return;
      case "auth_login_url":
      case "auth_login_end":
        yield* emitWarning(context, `omo event '${event.type}' is not supported yet`, event);
        return;
      case "extension_ui_request":
        yield* handleExtensionUiRequest(context, event);
        return;
      case "extension_event": {
        if (event.name === OMO_MONITOR_STATE_EVENT_NAME) {
          // The authoritative monitor snapshot: a watch the payload omits has
          // ended, which is the only way a naturally-exited monitor (command
          // finished on its own, never killed) stops reading as active. A
          // payload carrying no per-monitor detail is absence, not emptiness,
          // so it must never end every watch.
          const monitors = decodeOmoMonitorStateEvent(event.data);
          if (monitors === undefined) return;
          if (applyOmoMonitorStateEvent(context.monitorProjection, monitors)) {
            yield* emitSteeringProjection(context);
          }
          return;
        }
        if (event.name === "omo.dag.updated") {
          const dagRuns = decodeOmoDagUpdatedRuns(event.data, context.handle.durableSessionId);
          if (dagRuns === undefined) return;
          context.dagRuns = mergeOmoDagActivityIntoRuns(dagRuns, context.dagActivityByNode);
          context.dagRunsDirty = true;
          // Dag runs are the omo driver's background agent work: synthesize the
          // task lifecycle stream the sidebar's background-liveness registry
          // consumes, so a live run keeps the thread Working after the parent
          // turn settles (parity with Claude/Codex fleet handling).
          const liveness = diffOmoDagRunLiveness(context.dagRunLiveness, dagRuns);
          for (const run of liveness.started) {
            yield* offerEvent({
              ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
              type: "task.started",
              payload: {
                taskId: omoDagRunLivenessTaskId(run.runId),
                description: run.name,
                timelineBypass: true,
              },
            } satisfies ProviderRuntimeEvent);
          }
          for (const run of liveness.completed) {
            yield* offerEvent({
              ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
              type: "task.completed",
              payload: {
                taskId: omoDagRunLivenessTaskId(run.runId),
                status: run.status,
              },
            } satisfies ProviderRuntimeEvent);
          }
          context.dagRunLiveness = liveness.liveRuns;
          yield* emitSteeringProjection(context);
          return;
        }
        if (event.name === "omo.dag.activity") {
          const activity = decodeOmoDagActivity(event.data);
          if (activity === undefined) return;
          context.dagActivityByNode.set(`${activity.runId}:${activity.nodeId}`, activity.activity);
          context.dagRuns = mergeOmoDagActivityIntoRuns(context.dagRuns, context.dagActivityByNode);
          context.dagRunsDirty = true;
          yield* emitSteeringProjection(context);
          return;
        }
        if (event.name !== "omo.task.updated") return;
        const subagents = decodeOmoTaskUpdatedSubagents(
          event.data,
          context.handle.durableSessionId,
        );
        if (subagents === undefined) return;
        context.subagents = subagents;
        context.hasLiveSubagentSnapshot = true;
        // Task children are background agent work exactly like dag runs:
        // synthesize the task lifecycle stream ThreadBackgroundLiveness
        // consumes, so live children keep the thread Working after the parent
        // turn settles (observed gap: settled turn + churning verifier
        // children read Ready in the sidebar).
        const subagentLiveness = diffOmoSubagentLiveness(context.subagentLiveness, subagents);
        for (const task of subagentLiveness.started) {
          yield* offerEvent({
            ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
            type: "task.started",
            payload: {
              taskId: omoSubagentLivenessTaskId(task.taskId),
              description: task.description,
              timelineBypass: true,
            },
          } satisfies ProviderRuntimeEvent);
        }
        for (const task of subagentLiveness.completed) {
          yield* offerEvent({
            ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
            type: "task.completed",
            payload: {
              taskId: omoSubagentLivenessTaskId(task.taskId),
              status: task.status,
            },
          } satisfies ProviderRuntimeEvent);
        }
        context.subagentLiveness = subagentLiveness.liveTasks;
        yield* emitSteeringProjection(context);
        return;
      }
      case "extension_error":
        yield* emitWarning(context, event.error, event);
        return;
      case "entry_appended": {
        const entry = event.entry;
        if (!isOmoRecord(entry)) return;
        if (entry.type === "model_change") {
          const provider = omoString(entry, "provider");
          const modelId = omoString(entry, "modelId");
          if (provider === undefined || modelId === undefined) return;
          const reason = omoString(entry, "reason");
          // Omo appends these entries before the paired retry_fallback event;
          // that later event is always the single authoritative transition.
          if (reason === "fallback" || reason === "fallback-revert") return;
          const observedModel = { provider, modelId } satisfies OmoModelRef;
          if (
            context.pendingAppliedModelChange !== undefined &&
            sameModel(context.pendingAppliedModelChange, observedModel)
          ) {
            context.pendingAppliedModelChange = undefined;
            return;
          }
          context.pendingAppliedModelChange = undefined;
          const fromProvider = omoString(entry, "originalProvider");
          const fromModelId = omoString(entry, "originalModelId");
          const fromModel =
            fromProvider === undefined || fromModelId === undefined
              ? undefined
              : `${fromProvider}/${fromModelId}`;
          const toModel = `${provider}/${modelId}`;
          if (!(yield* updateObservedSessionModel(context, toModel))) return;
          yield* emitModelRerouted(context, event, {
            ...(fromModel === undefined ? {} : { fromModel }),
            toModel,
            reasonClass: "external",
            ...(context.lastKnownThinkingLevel === undefined
              ? {}
              : { thinkingLevel: context.lastKnownThinkingLevel }),
          });
          return;
        }
        if (entry.type !== "custom") return;
        const customType = omoString(entry, "customType");
        if (customType === "rule-activation" && isOmoRecord(entry.data)) {
          const data = entry.data;
          const kind = data.kind;
          const rules = Array.isArray(data.rules)
            ? data.rules.filter((rule): rule is string => typeof rule === "string")
            : [];
          if (kind === "ttsr") {
            const owner = omoString(data, "owner");
            const remediation = data.remediation;
            if (
              owner === undefined ||
              (remediation !== "nudge" && remediation !== "provider-error")
            )
              return;
            yield* offerEvent({
              ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
              type: "rule.injected",
              payload: { kind, owner, rules, remediation },
            } satisfies ProviderRuntimeEvent);
            return;
          }
          if (kind === "project-rules") {
            const targetPath = omoString(data, "targetPath");
            if (targetPath === undefined) return;
            yield* offerEvent({
              ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
              type: "rule.injected",
              payload: { kind, targetPath, rules },
            } satisfies ProviderRuntimeEvent);
          }
          return;
        }
        if (customType === "ttsr-remediation-error") {
          const message =
            isOmoRecord(entry.data) && omoString(entry.data, "error") !== undefined
              ? omoString(entry.data, "error")!
              : "omo TTSR remediation failed";
          yield* emitWarning(context, message, event, "error");
        }
        return;
      }
      case "unknown":
        yield* emitWarning(context, `omo emitted an unknown event '${event.eventType}'`, event);
        return;
      case "retry_fallback_applied":
        context.pendingAppliedModelChange = undefined;
        if (!(yield* updateObservedSessionModel(context, event.to))) return;
        yield* emitModelRerouted(context, event, {
          fromModel: event.from,
          toModel: event.to,
          reason: event.reason,
          reasonClass: event.reason,
          phase: "applied",
          chainKey: event.chainKey,
          ...(context.lastKnownThinkingLevel === undefined
            ? {}
            : { thinkingLevel: context.lastKnownThinkingLevel }),
        });
        return;
      case "retry_fallback_succeeded":
        yield* emitModelRerouted(context, event, {
          toModel: event.model,
          phase: "succeeded",
          chainKey: event.chainKey,
        });
        return;
      case "retry_fallback_reverted":
        context.pendingAppliedModelChange = undefined;
        if (!(yield* updateObservedSessionModel(context, event.to))) return;
        yield* emitModelRerouted(context, event, {
          fromModel: event.from,
          toModel: event.to,
          phase: "reverted",
          ...(context.lastKnownThinkingLevel === undefined
            ? {}
            : { thinkingLevel: context.lastKnownThinkingLevel }),
        });
        return;
      case "retry_fallback_exhausted":
        yield* emitModelRerouted(context, event, {
          phase: "exhausted",
          chainKey: event.chainKey,
          reason: event.lastError,
        });
        return;
      case "server_fallback_aborted":
        yield* emitModelRerouted(context, event, {
          fromModel: event.from,
          toModel: event.to,
          phase: "aborted",
        });
        return;
      case "system_prompt_change":
      case "retry_probe_scheduled":
      case "retry_probe_result":
        yield* Effect.logDebug("omo.runtime.signal.ignored", {
          threadId: context.threadId,
          eventType: event.type,
        });
        return;
      case "queue_update": {
        yield* Effect.logDebug("omo.runtime.signal.ignored", {
          threadId: context.threadId,
          eventType: event.type,
        });
        context.queuedMessages = [
          ...event.steering.map((text) => ({ text, mode: "steer" as const })),
          ...event.followUp.map((text) => ({ text, mode: "followUp" as const })),
        ];
        const reconciled = yield* reconcileThinkingLevel(context);
        if (reconciled.kind !== "success") yield* emitSteeringProjection(context);
        return;
      }
      // `agent_settled` already completes the turn; `agent_idle` fires strictly after it, once
      // omo's settlement-deferred continuations resolve without starting a run. It exists for
      // omo's own TUI cleanup and carries no T3-observable transition, so it stays traced-only.
      case "agent_idle":
      case "compaction_start":
      case "compaction_progress":
      case "compaction_end":
      case "session_abort":
      case "bash_execution_update":
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start":
      case "summarization_retry_finished":
      // `model_changed` duplicates the `entry_appended` model_change signal that
      // already drives the session model mirror; acting on both would emit two
      // reroutes for one change, so the entry path stays the single actor.
      case "model_changed":
      case "service_tier_changed":
      case "settings_source_selected":
        yield* Effect.logDebug("omo.runtime.signal.ignored", {
          threadId: context.threadId,
          eventType: event.type,
        });
        return;
      case "high_reasoning_warning":
      case "loaded_surfaces_changed":
      // Explicit invocation evidence: `skill_invocation` names the skills a prompt selected and
      // `command_invocation` names the slash command a session resolved. Neither carries assistant
      // content nor a turn lifecycle transition, so both stay deliberate no-ops.
      case "skill_invocation":
      case "command_invocation":
      // `commands_changed` invalidates omo's ordered slash-command snapshot after a
      // post-bind reload. T3 never fetches `get_commands`, so the refreshed surface
      // carries no T3-observable transition and stays a deliberate no-op.
      case "commands_changed":
      case "auth_accounts_changed":
      case "account_failover":
        return;
      default:
        return assertNever(event);
    }
  });

  const handleSharedTerminal = Effect.fn("OmoAdapter.handleSharedTerminal")(function* (
    context: OmoSessionContext,
    event: { readonly exitCode: number | null; readonly stderrTail: string },
  ) {
    if (context.terminal) return;
    context.terminal = true;
    context.stopped = true;
    const active = context.activeTurn;
    if (active !== null) clearTurnToolCallMappings(active);
    context.hookStatusByToolCallId.clear();
    context.toolInputsByToolCallId.clear();
    context.todoPlanState = undefined;
    const message = nonEmpty(
      event.stderrTail,
      `omo exited with code ${event.exitCode === null ? "unknown" : event.exitCode}`,
    );
    yield* resolvePendingDialogs(context, event);
    yield* offerEvent({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        raw: event,
        ...(active === null ? {} : { turnId: active.turnId }),
      })),
      type: "runtime.error",
      payload: { message, class: "transport_error" },
    } satisfies ProviderRuntimeEvent);
    if (active !== null && !active.completed) {
      active.outcome = { kind: "failed", message };
      active.completed = true;
      yield* offerEvent({
        ...(yield* makeEventBase({
          threadId: context.threadId,
          turnId: active.turnId,
          raw: event,
        })),
        type: "turn.completed",
        payload: { state: "failed", errorMessage: message },
      } satisfies ProviderRuntimeEvent);
      context.activeTurn = null;
      yield* releaseTurnGate(context, active);
    }
    yield* offerEvent({
      ...(yield* makeEventBase({ threadId: context.threadId, raw: event })),
      type: "session.exited",
      payload: {
        reason: message,
        recoverable: context.session.resumeCursor !== undefined,
        exitKind: "error",
      },
    } satisfies ProviderRuntimeEvent);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore, Effect.forkIn(adapterScope));
  });

  const dispatchSharedRecord = Effect.fn("OmoAdapter.dispatchSharedRecord")(function* (input: {
    readonly epoch: number;
    readonly record: Readonly<Record<string, unknown>>;
  }) {
    const terminalExitCode = input.record.exitCode;
    if (
      input.record._tag === "OmoSharedProcessExit" &&
      (typeof terminalExitCode === "number" || terminalExitCode === null)
    ) {
      pendingExtensionEvents.clear();
      closedExtensionEventRoutes.clear();
      const terminal = {
        exitCode: terminalExitCode,
        stderrTail: typeof input.record.stderrTail === "string" ? input.record.stderrTail : "",
      };
      yield* Effect.forEach(
        Array.from(sessions.values()).filter(
          (context) => context.handle.routing.epoch === input.epoch && !context.terminal,
        ),
        (context) => handleSharedTerminal(context, terminal),
        { concurrency: 1, discard: true },
      );
      return;
    }
    const decoded = decodeOmoInboundRecord(input.record);
    if (Result.isFailure(decoded)) {
      yield* Effect.logWarning("omo.shared.record.invalid", { reason: decoded.failure.reason });
      return;
    }
    const record = decoded.success;
    if (record.type === "response" || record.sessionId === undefined) {
      yield* Effect.logWarning("omo.shared.record.untagged", {
        epoch: input.epoch,
        type: record.type,
      });
      return;
    }
    const context = Array.from(sessions.values()).find(
      (candidate) =>
        candidate.handle.routing.epoch === input.epoch &&
        candidate.handle.routing.sessionId === record.sessionId &&
        !candidate.stopped &&
        !candidate.terminal,
    );
    if (context === undefined) {
      if (
        record.type === "extension_event" &&
        record.name !== undefined &&
        bufferedExtensionEventNames.has(record.name)
      ) {
        const key = pendingExtensionEventKey(input.epoch, record.sessionId);
        if (closedExtensionEventRoutes.has(key)) return;
        const buffered = pendingExtensionEvents.get(key) ?? [];
        if (buffered.length >= maxPendingExtensionEventsPerRoute) return;
        if (
          !pendingExtensionEvents.has(key) &&
          pendingExtensionEvents.size >= maxPendingExtensionEventRoutes
        )
          return;
        pendingExtensionEvents.set(key, [...buffered, record]);
        return;
      }
      // A session_closed notification from an older shared-process epoch is a
      // redundant tail of the process that already emitted OmoSharedProcessExit.
      // That exit finalizes every context it owned; only the current epoch's
      // unrouted close remains actionable enough to warn about.
      const sharedState =
        record.type === "unknown" && record.eventType === "session_closed"
          ? yield* shared.state
          : undefined;
      const staleEpochSessionClosed = sharedState !== undefined && sharedState.epoch > input.epoch;
      if (staleEpochSessionClosed) {
        yield* Effect.logDebug("omo.shared.record.stale_epoch_ignored", {
          epoch: input.epoch,
          currentEpoch: sharedState.epoch,
          sessionId: record.sessionId,
          type: record.type,
          eventType: (record as { eventType?: string }).eventType,
        });
        return;
      }
      // Response-less UI requests are ignored even by routed sessions, so an
      // unrouted copy from a probe/control session is expected chatter too.
      const bootstrapChrome =
        record.type === "extension_ui_request" &&
        RESPONSE_LESS_UI_REQUEST_METHODS.has(record.method);
      // Session-state broadcasts are ignored even for routed sessions (see the
      // runtime signal cases above), so an unrouted copy is expected chatter
      // from omo's short-lived probe/control sessions, not a routing defect.
      const stateBroadcast =
        record.type === "settings_source_selected" ||
        record.type === "loaded_surfaces_changed" ||
        record.type === "commands_changed" ||
        record.type === "model_changed" ||
        record.type === "service_tier_changed";
      // Extension events outside the buffered task/dag set are ignored even by
      // routed sessions (see the extension_event handler above), so an
      // unrouted copy from a probe/control session is expected chatter too.
      const ignoredExtensionEvent =
        record.type === "extension_event" &&
        (record.name === undefined || !bufferedExtensionEventNames.has(record.name));
      yield* (
        bootstrapChrome || stateBroadcast || ignoredExtensionEvent
          ? Effect.logDebug
          : Effect.logWarning
      )(
        bootstrapChrome
          ? "omo.shared.record.bootstrap_chrome_ignored"
          : stateBroadcast
            ? "omo.shared.record.state_broadcast_unrouted"
            : ignoredExtensionEvent
              ? "omo.shared.record.extension_event_unrouted_ignored"
              : "omo.shared.record.unroutable",
        {
          epoch: input.epoch,
          sessionId: record.sessionId,
          type: record.type,
          // Name the concrete wire discriminant: a bare `type: 'unknown'` (or a
          // methodless ui request) is undiagnosable from production logs.
          ...(record.type === "unknown" ? { eventType: record.eventType } : {}),
          ...(record.type === "extension_ui_request" ? { method: record.method } : {}),
          ...(record.type === "extension_event" && record.name !== undefined
            ? { name: record.name }
            : {}),
        },
      );
      return;
    }
    yield* Queue.offer(context.eventQueue, record).pipe(Effect.asVoid);
  });

  yield* shared.records.pipe(
    Stream.runForEach(dispatchSharedRecord),
    Effect.catchCause((cause) => Effect.logWarning("omo.shared.records.failed", { cause })),
    Effect.forkIn(adapterScope),
  );

  const finalizeContext = Effect.fn("OmoAdapter.finalizeContext")(function* (
    context: OmoSessionContext,
  ) {
    if (context.terminal) return;
    context.terminal = true;
    context.stopped = true;
    sessions.delete(context.threadId);
    const active = context.activeTurn;
    context.activeTurn = null;
    if (active !== null) {
      clearTurnToolCallMappings(active);
      yield* releaseTurnGate(context, active);
    }
    context.hookStatusByToolCallId.clear();
    context.toolInputsByToolCallId.clear();
    context.todoPlanState = undefined;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    // The goal watch dies with this scope; read the file one last time so a
    // goal write that raced the stop (e.g. the model completing the goal
    // during final-turn teardown) still projects instead of leaving the pill
    // stuck on the pre-stop value until the next session start.
    const onGoalUpdated = options.onGoalUpdated;
    if (onGoalUpdated !== undefined) {
      const reconciledGoal = yield* reconcileOmoGoalOnStop({
        location: resolveOmoGoalFile(context.sessionFile, context.handle.durableSessionId),
        lastProjected: context.lastProjectedGoal,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      if (reconciledGoal !== undefined) {
        context.lastProjectedGoal = reconciledGoal;
        yield* onGoalUpdated({
          threadId: context.threadId,
          goal: reconciledGoal as ThreadGoal | null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        }).pipe(Effect.ignore);
      }
    }
    yield* resolvePendingDialogs(context, { type: "scope_closed" });
    yield* offerEvent({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        raw: { type: "scope_closed" },
      })),
      type: "session.exited",
      payload: { reason: "omo session stopped", recoverable: true, exitKind: "graceful" },
    } satisfies ProviderRuntimeEvent).pipe(Effect.ignore);
  });

  const stopContext = Effect.fn("OmoAdapter.stopContext")(function* (context: OmoSessionContext) {
    if (context.stopped && context.terminal) return;
    context.stopped = true;
    // Bounded grace: a wedged child that stops answering close_session must
    // not hang stopAll (and therefore server shutdown) forever. The supervisor
    // finalizer's gracefullyStopChild/killChild escalation reaps the child
    // regardless of whether this close was acknowledged.
    yield* context.handle.close.pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
  });

  const resolveStartModel = Effect.fn("OmoAdapter.resolveStartModel")(function* (
    model: string | undefined,
  ) {
    if (model === undefined || model.trim().length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "omo has no usable model selected - authenticate omo and pick a model",
      });
    }
    const decoded = decodeOmoModelSlug(model);
    if (Result.isFailure(decoded)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: decoded.failure.reason,
        cause: decoded.failure,
      });
    }
    return decoded.success;
  });

  const parseResumeCursor = Effect.fn("OmoAdapter.parseResumeCursor")(function* (
    input: unknown,
    threadId: ThreadId,
    sessionDirectory: string,
  ) {
    const cursor = yield* decodeResumeCursor(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "resume cursor is malformed",
            cause,
          }),
      ),
    );
    if (
      cursor.threadId !== threadId ||
      cursor.sessionFile.trim().length === 0 ||
      cursor.sessionId.trim().length === 0
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue:
          cursor.threadId !== threadId
            ? "resume cursor belongs to a different thread"
            : "resume cursor is malformed",
      });
    }
    const owned = yield* isPathInsideOmoSessionDir(sessionDirectory, cursor.sessionFile).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "resume cursor path is not owned by this omo instance",
            cause,
          }),
      ),
    );
    if (!owned) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "resume cursor path is not owned by this omo instance",
      });
    }
    return cursor;
  });

  const canonicalSessionPath = (candidate: string) =>
    fileSystem.realPath(candidate).pipe(Effect.orElseSucceed(() => path.resolve(candidate)));

  /**
   * Closes whichever session still holds `sessionFile` inside the shared child.
   * The adapter owns every session under this instance's session directory, so a
   * holder it has no context for is a leftover from a failed open that can never
   * be reattached - reclaiming it turns a permanently wedged thread back into a
   * startable one instead of failing every later turn with session_path_in_use.
   */
  const reclaimStrandedSessionFile = Effect.fn("OmoAdapter.reclaimStrandedSessionFile")(function* (
    sessionFile: string,
  ) {
    const listed = yield* shared.request({ type: "list_sessions" }, "probe").pipe(
      Effect.map((record) => decodeOmoListedSessions(record.data)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<OmoListedSession>),
    );
    const canonicalTarget = yield* canonicalSessionPath(sessionFile);
    for (const entry of listed) {
      if (entry.sessionPath === undefined) continue;
      const canonicalEntry = yield* canonicalSessionPath(entry.sessionPath);
      if (canonicalEntry !== canonicalTarget) continue;
      yield* Effect.logWarning("omo.session.reclaiming-stranded-path", {
        sessionFile,
        sessionId: entry.sessionId,
        status: entry.status,
      });
      yield* shared
        .request({ type: "close_session", sessionId: entry.sessionId }, "close_session")
        .pipe(Effect.ignore);
    }
  });

  const startSession: OmoAdapterShape["startSession"] = (input) =>
    withSessionLifecycleGate(
      input.threadId,
      Effect.scoped(
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          const existing = sessions.get(input.threadId);
          if (existing !== undefined) yield* stopContext(existing);

          // omo's open_session replies a bare `open_failed` with no reason when
          // the cwd is missing (e.g. a project created on another machine sharing
          // this state DB), so diagnose the missing directory before asking.
          if (input.cwd !== undefined) {
            const cwdExists = yield* fileSystem
              .exists(input.cwd)
              .pipe(Effect.orElseSucceed(() => false));
            if (!cwdExists) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: `open_failed: workspace directory '${input.cwd}' does not exist on this machine`,
              });
            }
          }

          const sessionDirectory = resolveOmoSessionDir(serverConfig.stateDir, boundInstanceId);
          yield* ensureOmoSessionDir(sessionDirectory).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to prepare the omo session directory.",
                  cause,
                }),
            ),
          );

          const resumeCursor: OmoResumeCursor | undefined =
            input.resumeCursor === undefined
              ? undefined
              : yield* parseResumeCursor(input.resumeCursor, input.threadId, sessionDirectory);
          const requestedModel =
            resumeCursor === undefined
              ? yield* resolveStartModel(input.modelSelection?.model)
              : undefined;
          const requestedThinkingLevel =
            resumeCursor === undefined
              ? sanitizeThinkingLevelSelection(
                  getModelSelectionStringOptionValue(
                    input.modelSelection,
                    THINKING_LEVEL_OPTION_ID,
                  ),
                )
              : undefined;
          const sessionFile =
            resumeCursor?.sessionFile ??
            (yield* allocateSessionFile(sessionDirectory, input.threadId));
          const sessionScope = yield* Scope.make("sequential");
          let transferred = false;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const openOptions = {
            sessionFile,
            cwd: input.cwd ?? serverConfig.stateDir,
            permissionPreset: omoPermissionPreset(input.runtimeMode ?? "auto"),
            model: requestedModel,
            thinkingLevel: requestedThinkingLevel,
            expectedSessionId: resumeCursor?.sessionId,
          };
          const handle = yield* openOmoSessionHandle(shared, openOptions).pipe(
            // A path this adapter still owns can only be held by a session it lost
            // track of, so reclaim it once and retry rather than wedging the thread.
            Effect.catchIf(isOmoSessionPathInUse, () =>
              reclaimStrandedSessionFile(sessionFile).pipe(
                Effect.andThen(openOmoSessionHandle(shared, openOptions)),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: runtimeErrorDetail(cause),
                  cause,
                }),
            ),
          );
          const sessionRoutingKey = pendingExtensionEventKey(
            handle.routing.epoch,
            handle.routing.sessionId,
          );
          yield* Scope.addFinalizer(
            sessionScope,
            Effect.sync(() => {
              pendingExtensionEvents.delete(sessionRoutingKey);
              closedExtensionEventRoutes.add(sessionRoutingKey);
              if (closedExtensionEventRoutes.size <= maxClosedExtensionEventRoutes) return;
              const oldest = closedExtensionEventRoutes.values().next().value;
              if (oldest !== undefined) closedExtensionEventRoutes.delete(oldest);
            }),
          );
          const now = DateTime.formatIso(yield* DateTime.now);
          const cursor: OmoResumeCursor = {
            threadId: input.threadId,
            sessionFile,
            sessionId: handle.durableSessionId,
          };
          const currentModel =
            handle.readiness.model === undefined
              ? undefined
              : {
                  provider: handle.readiness.model.provider,
                  modelId: handle.readiness.model.id,
                };
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode ?? "auto",
            cwd: input.cwd ?? serverConfig.stateDir,
            ...(currentModel === undefined ? {} : { model: encodeOmoModelSlug(currentModel) }),
            threadId: input.threadId,
            resumeCursor: cursor,
            createdAt: now,
            updatedAt: now,
          };
          const context: OmoSessionContext = {
            threadId: input.threadId,
            handle,
            eventQueue: yield* Queue.unbounded<OmoEvent>(),
            scope: sessionScope,
            sessionFile,
            currentModel,
            pendingAppliedModelChange: undefined,
            lastKnownThinkingLevel: sanitizeThinkingLevelSelection(
              handle.readiness.thinkingLevel ?? undefined,
            ),
            sendGate: yield* Semaphore.make(1),
            pendingDialogs: new Map(),
            dialogRequestsByNativeId: new Map(),
            hookStatusByToolCallId: new Map(),
            toolInputsByToolCallId: new Map(),
            todoPlanState: undefined,
            monitorProjection: createOmoMonitorProjection(),
            monitorWarnings: [],
            isStreaming: handle.readiness.isStreaming,
            pendingMessageCount: handle.readiness.pendingMessageCount,
            autoCompactionEnabled: projectOmoAutoCompaction(handle.readiness),
            queuedMessages: [],
            subagents: [],
            dagRuns: [],
            dagActivityByNode: new Map(),
            dagRunsDirty: false,
            dagRunLiveness: new Map(),
            subagentLiveness: new Map(),
            hasLiveSubagentSnapshot: false,
            activeWorks: [],
            ulwActive: false,
            lastProjectedGoal: null,
            session,
            activeTurn: null,
            stopped: false,
            terminal: false,
          };
          yield* Scope.addFinalizer(sessionScope, finalizeContext(context));
          yield* registerOmoSessionContext(
            shared,
            handle.routing,
            () => {
              const bufferedExtensionEvents = pendingExtensionEvents.get(sessionRoutingKey) ?? [];
              pendingExtensionEvents.delete(sessionRoutingKey);
              closedExtensionEventRoutes.delete(sessionRoutingKey);
              Queue.offerAllUnsafe(context.eventQueue, bufferedExtensionEvents);
              sessions.set(input.threadId, context);
            },
            { provider: PROVIDER, threadId: input.threadId },
          );
          transferred = true;
          // A resumed session ignores the model this open asked for: senpi
          // restores the transcript's persisted model and discards the
          // caller's creationModel. Reconcile before anything can prompt, so
          // the engine runs the model the thread displays.
          if (resumeCursor !== undefined) {
            yield* reconcileResumedModel(context, input.modelSelection?.model);
            yield* hydrateMonitorProjection(context);
          }
          yield* emitSteeringProjection(context);
          if (options.onSteeringUpdated !== undefined) {
            const projectDir = input.cwd ?? process.cwd();
            yield* Stream.runForEach(
              watchOmoSubagents(projectDir, [
                { threadId: input.threadId, durableSessionId: handle.durableSessionId },
              ]),
              (projection) => {
                if (context.hasLiveSubagentSnapshot) return Effect.void;
                context.subagents = projection.subagents;
                return emitSteeringProjection(context);
              },
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.forkIn(sessionScope),
            );
            yield* Stream.runForEach(watchOmoWorkActivity(projectDir), (summary) => {
              context.activeWorks = summary.activeWorks;
              return emitSteeringProjection(context);
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.forkIn(sessionScope),
            );
          }
          yield* Stream.fromQueue(context.eventQueue).pipe(
            Stream.runForEach((event) =>
              (options.beforeProjectSessionEvent?.(context.threadId, event) ?? Effect.void).pipe(
                Effect.andThen(handleRuntimeEvent(context, event)),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(sessionScope),
          );
          if (options.onGoalUpdated !== undefined) {
            yield* Stream.runForEach(
              watchOmoGoal({
                sessionFile,
                durableSessionId: handle.durableSessionId,
              }),
              (goal) =>
                Effect.gen(function* () {
                  const onGoalUpdated = options.onGoalUpdated;
                  if (onGoalUpdated === undefined) return;
                  context.lastProjectedGoal = goal;
                  yield* onGoalUpdated({
                    threadId: input.threadId,
                    goal,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  });
                }),
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.forkIn(sessionScope),
            );
          }
          const readinessRaw = {
            type: "response",
            command: "get_state",
            success: true,
            data: handle.readiness,
          };
          yield* offerEvent({
            ...(yield* makeEventBase({
              threadId: input.threadId,
              raw: readinessRaw,
              method: "get_state",
            })),
            type: "session.started",
            payload: { resume: cursor },
          } satisfies ProviderRuntimeEvent);
          yield* offerEvent({
            ...(yield* makeEventBase({
              threadId: input.threadId,
              raw: readinessRaw,
              method: "get_state",
            })),
            type: "session.state.changed",
            payload: { state: "ready" },
          } satisfies ProviderRuntimeEvent);
          yield* offerEvent({
            ...(yield* makeEventBase({
              threadId: input.threadId,
              raw: readinessRaw,
              method: "get_state",
            })),
            type: "thread.started",
            payload: { providerThreadId: handle.durableSessionId },
          } satisfies ProviderRuntimeEvent);
          // Not the local `session`: resumed-model reconciliation may have
          // replaced it with one carrying the model the engine confirmed.
          return context.session;
        }),
      ),
    );

  const resolveAttachment = Effect.fn("OmoAdapter.resolveAttachment")(function* (
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ): Effect.fn.Return<OmoImageContent, ProviderAdapterRequestError> {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (attachmentPath === null) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return omoImageContentFromBytes(bytes, attachment.mimeType);
  });

  const resolveTurnModel = Effect.fn("OmoAdapter.resolveTurnModel")(function* (
    input: ProviderSendTurnInput,
  ) {
    if (input.modelSelection === undefined) return undefined;
    const decoded = decodeOmoModelSlug(input.modelSelection.model);
    if (Result.isFailure(decoded)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: decoded.failure.reason,
        cause: decoded.failure,
      });
    }
    return decoded.success;
  });

  const applySessionModel = Effect.fn("OmoAdapter.applySessionModel")(function* (
    context: OmoSessionContext,
    requestedModel: OmoModelRef,
    method: "session/setModel" | "turn/start",
  ) {
    if (context.currentModel !== undefined && sameModel(requestedModel, context.currentModel)) {
      return context.currentModel;
    }
    const appliedModel = yield* sendSetModel(context.handle, requestedModel).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: runtimeErrorDetail(cause),
            cause,
          }),
      ),
    );
    context.currentModel = appliedModel;
    context.pendingAppliedModelChange = appliedModel;
    context.lastKnownThinkingLevel = undefined;
    context.session = {
      ...context.session,
      model: encodeOmoModelSlug(appliedModel),
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    return appliedModel;
  });

  /**
   * Bring a resumed session's model back in line with the thread's selection.
   *
   * Runs while the session is registered but before any turn can be admitted,
   * so a rejected `set_model` fails the START rather than letting a prompt run
   * on a model the thread never claimed. Applied state stays a cache of
   * provider-observed values: `applySessionModel` writes it only after the
   * command succeeded, and a failure here tears the session down instead of
   * publishing a model the engine is not on.
   */
  const reconcileResumedModel = Effect.fn("OmoAdapter.reconcileResumedModel")(function* (
    context: OmoSessionContext,
    threadModel: string | undefined,
  ) {
    const plan = planResumedModelReconciliation({
      threadModel,
      restoredModel: context.currentModel,
    });
    if (plan.kind === "keep") return;
    if (plan.kind === "undecodable") {
      yield* stopContext(context);
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: plan.reason,
      });
    }
    yield* Effect.logInfo("omo.session.resumed-model-reconciled", {
      threadId: context.threadId,
      restoredModel:
        context.currentModel === undefined ? null : encodeOmoModelSlug(context.currentModel),
      threadModel: encodeOmoModelSlug(plan.model),
    });
    yield* applySessionModel(context, plan.model, "session/setModel").pipe(
      Effect.tapError(() => stopContext(context)),
    );
  });

  const setSessionModel: OmoAdapterShape["setSessionModel"] = Effect.fn(
    "OmoAdapter.setSessionModel",
  )(function* (threadId, model) {
    const context = yield* requireSession(threadId);
    const decoded = decodeOmoModelSlug(model);
    if (Result.isFailure(decoded)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "setSessionModel",
        issue: decoded.failure.reason,
        cause: decoded.failure,
      });
    }
    const appliedModel = yield* applySessionModel(context, decoded.success, "session/setModel");
    return encodeOmoModelSlug(appliedModel);
  });

  const finishCompletionRaw = Effect.fn("OmoAdapter.finishCompletionRaw")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
  ) {
    if (
      context.activeTurn !== active ||
      active.completed ||
      context.terminal ||
      active.pendingPromptAdmissions > 0 ||
      active.completionRaw === undefined
    ) {
      return;
    }
    yield* reconcileThinkingLevel(context);
    if (
      context.activeTurn !== active ||
      active.completed ||
      context.terminal ||
      active.pendingPromptAdmissions > 0 ||
      active.completionRaw === undefined
    ) {
      return;
    }
    yield* finishTurn(context, active, active.completionRaw);
  });

  const runPostAcceptance = Effect.fn("OmoAdapter.runPostAcceptance")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
  ) {
    yield* Effect.yieldNow;
    if (context.activeTurn !== active || active.completed || context.terminal) return;
    active.completionAllowed = true;
    if (active.completionRaw !== undefined) {
      yield* finishCompletionRaw(context, active);
      return;
    }
    if (active.sawAgentStart) return;
    const stateResponse = yield* reconcileThinkingLevel(context);
    if (context.activeTurn !== active || active.completed || context.terminal) return;
    if (stateResponse.kind === "failure") {
      active.outcome = { kind: "failed", message: runtimeErrorDetail(stateResponse.error) };
      if (active.pendingPromptAdmissions > 0) {
        active.completionRaw = stateResponse.error;
        return;
      }
      yield* finishTurn(context, active, stateResponse.error);
      return;
    }
    if (stateResponse.kind === "invalid") {
      active.outcome = { kind: "failed", message: "omo returned an invalid session state" };
      if (active.pendingPromptAdmissions > 0) {
        active.completionRaw = stateResponse.response;
        return;
      }
      yield* finishTurn(context, active, stateResponse.response);
      return;
    }
    yield* Effect.yieldNow;
    if (
      context.activeTurn === active &&
      !active.completed &&
      !active.sawAgentStart &&
      active.pendingPromptAdmissions === 0 &&
      !stateResponse.state.isStreaming
    ) {
      yield* finishTurn(context, active, stateResponse.response);
    }
  });

  const reconcileThinkingLevel = Effect.fn("OmoAdapter.reconcileThinkingLevel")(function* (
    context: OmoSessionContext,
  ) {
    const response = yield* context.handle.send({ type: "get_state" }).pipe(
      Effect.match({
        onFailure: (error) => ({ kind: "failure" as const, error }),
        onSuccess: (success) => ({ kind: "success" as const, response: success }),
      }),
    );
    if (response.kind === "failure") {
      context.lastKnownThinkingLevel = undefined;
      return response satisfies ThinkingLevelReconciliation;
    }
    const decoded = decodeSessionState(response.response.data);
    if (Result.isFailure(decoded)) {
      context.lastKnownThinkingLevel = undefined;
      return {
        kind: "invalid" as const,
        response: response.response,
      } satisfies ThinkingLevelReconciliation;
    }
    context.lastKnownThinkingLevel = sanitizeThinkingLevelSelection(decoded.success.thinkingLevel);
    yield* applySteeringState(context, decoded.success);
    return {
      kind: "success" as const,
      response: response.response,
      state: decoded.success,
    } satisfies ThinkingLevelReconciliation;
  });

  const acceptTurn = Effect.fn("OmoAdapter.acceptTurn")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
    response: OmoSuccessfulResponse,
  ) {
    if (context.activeTurn !== active || context.terminal) return;
    active.accepted = true;
    yield* offerEvent({
      ...(yield* makeEventBase({
        threadId: context.threadId,
        turnId: active.turnId,
        raw: response,
        method: "prompt",
      })),
      type: "turn.started",
      payload:
        context.currentModel === undefined
          ? {}
          : { model: encodeOmoModelSlug(context.currentModel) },
    } satisfies ProviderRuntimeEvent);
    yield* Effect.forEach(active.bufferedEvents, offerEvent, { discard: true });
    active.bufferedEvents.length = 0;
    yield* runPostAcceptance(context, active).pipe(Effect.forkIn(adapterScope));
  });

  const rejectActiveTurn = Effect.fn("OmoAdapter.rejectActiveTurn")(function* (
    context: OmoSessionContext,
    active: ActiveTurn,
  ) {
    if (context.activeTurn === active) context.activeTurn = null;
    clearTurnToolCallMappings(active);
    context.hookStatusByToolCallId.clear();
    context.toolInputsByToolCallId.clear();
    yield* releaseTurnGate(context, active);
  });

  const sendTurn: OmoAdapterShape["sendTurn"] = Effect.fn("OmoAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    let pendingActive = context.activeTurn;
    if (pendingActive !== null) pendingActive.pendingPromptAdmissions += 1;
    const releasePendingAdmission = Effect.sync(() => {
      if (pendingActive === null) return;
      pendingActive.pendingPromptAdmissions -= 1;
      pendingActive = null;
    });
    yield* context.sendGate.take(1).pipe(Effect.onInterrupt(() => releasePendingAdmission));
    if (sessions.get(input.threadId) !== context || context.stopped || context.terminal) {
      yield* releasePendingAdmission;
      yield* context.sendGate.release(1);
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId: input.threadId,
      });
    }
    const steeringActive = context.activeTurn;
    if (steeringActive !== null) {
      if (pendingActive !== steeringActive) {
        yield* releasePendingAdmission;
        steeringActive.pendingPromptAdmissions += 1;
        pendingActive = steeringActive;
      }
      return yield* Effect.gen(function* () {
        if (input.interactionMode === "plan") {
          yield* emitWarning(context, "plan mode is not supported by omo; running default", {
            type: "prompt",
            interactionMode: input.interactionMode,
          });
        }
        const ensureAdmissionActive = Effect.suspend(() =>
          context.activeTurn === steeringActive &&
          !steeringActive.completed &&
          !steeringActive.abortIntent
            ? Effect.void
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: "omo turn was interrupted during admission",
                }),
              ),
        );
        const images = yield* Effect.forEach(input.attachments ?? [], resolveAttachment, {
          concurrency: 1,
        });
        const sent = yield* Effect.suspend(() =>
          context.activeTurn === steeringActive &&
          !steeringActive.completed &&
          !steeringActive.abortIntent
            ? sendOmoPromptSteerAware({
                command: {
                  type: "prompt",
                  message: input.input ?? "",
                  ...(images.length === 0 ? {} : { images }),
                },
                deliveryMode:
                  (
                    input as ProviderSendTurnInput & {
                      readonly deliveryMode?: ThreadTurnDeliveryMode;
                    }
                  ).deliveryMode ?? "steer",
                isStreaming: true,
                send: context.handle.send,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "turn/start",
                      detail: runtimeErrorDetail(cause),
                      cause,
                    }),
                ),
              )
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: "omo turn was interrupted during admission",
                }),
              ),
        );
        yield* ensureAdmissionActive;
        context.isStreaming = true;
        queueSteeredMessage(context, {
          text: input.input ?? "",
          mode: sent.deliveryMode === "followUp" ? "followUp" : "steer",
        });
        yield* emitSteeringProjection(context);
        yield* reconcileThinkingLevel(context);
        return {
          threadId: input.threadId,
          turnId: steeringActive.turnId,
          ...(context.session.resumeCursor === undefined
            ? {}
            : { resumeCursor: context.session.resumeCursor }),
        };
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* releasePendingAdmission;
            yield* context.sendGate.release(1);
            if (
              context.activeTurn === steeringActive &&
              !steeringActive.completed &&
              steeringActive.completionAllowed &&
              steeringActive.pendingPromptAdmissions === 0
            ) {
              if (steeringActive.completionRaw !== undefined) {
                yield* finishCompletionRaw(context, steeringActive);
              } else if (!steeringActive.sawAgentStart) {
                yield* runPostAcceptance(context, steeringActive);
              }
            }
          }),
        ),
      );
    }
    yield* releasePendingAdmission;
    const turnId = TurnId.make(`omo-turn-${runIdScope}${nextTurnSequence}`);
    nextTurnSequence += 1;
    const active: ActiveTurn = {
      turnId,
      bufferedEvents: [],
      toolCallItemIdsByToolCallId: new Map(),
      todoArgsByToolCallId: new Map(),
      outcome: { kind: "none" },
      provisionalError: undefined,
      sawAgentStart: false,
      abortIntent: false,
      accepted: false,
      completionAllowed: false,
      completionRaw: undefined,
      completed: false,
      pendingPromptAdmissions: 0,
      gateHeld: true,
      assistant: undefined,
    };
    context.activeTurn = active;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };

    return yield* Effect.gen(function* () {
      const images = yield* Effect.forEach(input.attachments ?? [], resolveAttachment, {
        concurrency: 1,
      });
      const requestedModel = yield* resolveTurnModel(input);
      if (requestedModel !== undefined) {
        yield* applySessionModel(context, requestedModel, "turn/start");
      }
      const rawThinkingLevel = getModelSelectionStringOptionValue(
        input.modelSelection,
        THINKING_LEVEL_OPTION_ID,
      );
      if (rawThinkingLevel !== undefined && typeof rawThinkingLevel !== "string") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "invalid thinking level selection: expected string",
        });
      }
      const thinkingLevel =
        rawThinkingLevel === undefined
          ? undefined
          : sanitizeThinkingLevelSelection(rawThinkingLevel);
      if (rawThinkingLevel !== undefined && thinkingLevel === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: "invalid thinking level selection: unsupported value",
        });
      }
      if (thinkingLevel !== undefined && thinkingLevel !== context.lastKnownThinkingLevel) {
        yield* context.handle
          .send({ type: "set_thinking_level", level: thinkingLevel, scope: "turn" })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "turn/start",
                  detail: `set_thinking_level failed: ${runtimeErrorDetail(cause)}`,
                  cause,
                }),
            ),
          );
        const confirmation = yield* context.handle.send({ type: "get_state" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: `get_state failed: ${runtimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );
        const decoded = decodeSessionState(confirmation.data);
        if (Result.isFailure(decoded)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "omo returned an invalid session state",
            cause: decoded.failure,
          });
        }
        const effectiveThinkingLevel = sanitizeThinkingLevelSelection(
          decoded.success.thinkingLevel,
        );
        if (effectiveThinkingLevel !== thinkingLevel) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `thinking level mismatch: requested ${thinkingLevel} got ${effectiveThinkingLevel ?? "undefined"}`,
          });
        }
        context.lastKnownThinkingLevel = effectiveThinkingLevel;
      }
      if (input.interactionMode === "plan") {
        yield* emitWarning(context, "plan mode is not supported by omo; running default", {
          type: "prompt",
          interactionMode: input.interactionMode,
        });
      }
      const wasStreaming = context.isStreaming;
      const sent = yield* sendOmoPromptSteerAware({
        command: {
          type: "prompt",
          message: input.input ?? "",
          ...(images.length === 0 ? {} : { images }),
          ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
        },
        deliveryMode:
          (input as ProviderSendTurnInput & { readonly deliveryMode?: ThreadTurnDeliveryMode })
            .deliveryMode ?? "steer",
        isStreaming: wasStreaming,
        send: context.handle.send,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: runtimeErrorDetail(cause),
              cause,
            }),
        ),
      );
      if (sent.deliveryMode !== "normal" && (wasStreaming || sent.retriedAsSteer)) {
        context.isStreaming = true;
        queueSteeredMessage(context, {
          text: input.input ?? "",
          mode: sent.deliveryMode === "followUp" ? "followUp" : "steer",
        });
        yield* emitSteeringProjection(context);
        yield* reconcileThinkingLevel(context);
      }
      yield* acceptTurn(context, active, sent.response);
      yield* releaseTurnGate(context, active);
      return {
        threadId: input.threadId,
        turnId,
        ...(context.session.resumeCursor === undefined
          ? {}
          : { resumeCursor: context.session.resumeCursor }),
      };
    }).pipe(Effect.onError(() => rejectActiveTurn(context, active)));
  });

  const interruptTurn: OmoAdapterShape["interruptTurn"] = Effect.fn("OmoAdapter.interruptTurn")(
    function* (threadId, turnId) {
      const context = yield* requireSession(threadId);
      const active = context.activeTurn;
      // Idempotent stop: with no active turn (or a caller naming an older,
      // already-finished turn) the desired end state - nothing running -
      // already holds, so this is a benign no-op success. Raising a typed
      // error here surfaced "omo has no matching active turn" as a
      // user-facing runtime warning on the completely ordinary race of
      // pressing Stop just as the turn settled (ClaudeAdapter has always
      // treated interrupt as idempotent-by-session; the engine interrupts by
      // session and never passes a turn id).
      if (active === null || (turnId !== undefined && turnId !== active.turnId)) {
        return;
      }
      active.abortIntent = true;
      active.outcome = { kind: "interrupted" };
      // Bounded abort: a wedged omo never answers {type:"abort"}; without a
      // timeout the turn never finishes locally (zombie turn). On send error OR
      // 10s timeout, recover locally: warn, finish interrupted, and request
      // shared-process refresh (epoch-invalidation recovery for a wedged child).
      const recoverAbort = (detail: string, raw: unknown) =>
        Effect.gen(function* () {
          yield* emitWarning(context, "omo did not acknowledge stop", {
            type: "abort",
            detail,
            raw,
          });
          if (context.activeTurn === active && !active.completed) {
            yield* finishTurn(context, active, { type: "abort", detail });
          }
          yield* shared.forceRestart ?? shared.refresh;
        });
      yield* context.handle.send({ type: "abort" }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: runtimeErrorDetail(cause),
              cause,
            }),
        ),
        Effect.timeoutOption(Duration.seconds(10)),
        Effect.matchEffect({
          onFailure: (error) => recoverAbort("abort send failed", error),
          onSuccess: (option) =>
            option._tag === "None"
              ? recoverAbort("abort timed out", { type: "timeout", duration: Duration.seconds(10) })
              : Effect.void,
        }),
      );
    },
  );

  const respondToRequest: OmoAdapterShape["respondToRequest"] = () =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "request/respond",
        detail: "omo emits no approval requests",
      }),
    );

  const respondToUserInput: OmoAdapterShape["respondToUserInput"] = Effect.fn(
    "OmoAdapter.respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingDialogs.get(requestId as ApprovalRequestId);
    if (pending === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: "user-input request not found or expired",
      });
    }
    const answer = answers[pending.questionId];
    if (typeof answer !== "string") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: "user-input answer must be a string",
      });
    }
    const response = omoDialogResponse(pending.nativeId, pending.method, answer);
    yield* context.handle.notify(response).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: runtimeErrorDetail(cause),
            cause,
          }),
      ),
    );
    const resolved = clearPendingDialog(context, requestId as ApprovalRequestId);
    if (resolved === undefined) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: "user-input request not found or expired",
      });
    }
    yield* emitDialogResolved({
      context,
      pending: resolved,
      answers,
      raw: response,
      bufferWithActiveTurn: true,
    });
  });

  const stopSession: OmoAdapterShape["stopSession"] = (threadId) =>
    withSessionLifecycleGate(
      threadId,
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (context !== undefined) yield* stopContext(context);
      }),
    );

  const listSessions: OmoAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values())
        .filter((context) => !context.stopped && !context.terminal)
        .map((context) => context.session),
    );

  const hasSession: OmoAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(
      (() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped && !context.terminal;
      })(),
    );

  const readThread: OmoAdapterShape["readThread"] = Effect.fn("OmoAdapter.readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      const response = yield* context.handle.send({ type: "get_entries" }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread/read",
              detail: runtimeErrorDetail(cause),
              cause,
            }),
        ),
      );
      const data = yield* decodeGetEntriesData(response.data).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread/read",
              detail: "omo returned an invalid get_entries response",
              cause,
            }),
        ),
      );
      context.monitorProjection = hydrateOmoMonitorProjection(
        data.entries,
        data.leafId,
        (warning) => context.monitorWarnings.push(warning),
      );
      yield* logMonitorWarnings(context);
      yield* emitSteeringProjection(context);
      if (data.leafId === null) return { threadId, turns: [] };

      /** Mutable reconstruction state; mutation is confined to snapshot building. */
      const entriesById = new Map<string, OmoHistoryNode>();
      for (const raw of data.entries) {
        const decoded = decodeHistoryEntry(raw);
        if (Result.isFailure(decoded)) {
          yield* Effect.logDebug("omo.readThread.entry.unparseable", {
            provider: PROVIDER,
            threadId,
          });
          continue;
        }
        entriesById.set(decoded.success.id, { entry: decoded.success, raw });
      }

      const chain: OmoHistoryNode[] = [];
      let cursor: string | null = data.leafId;
      while (cursor !== null) {
        const node = entriesById.get(cursor);
        if (node === undefined) break;
        chain.push(node);
        cursor = node.entry.parentId;
      }
      chain.reverse();

      const turns: Array<{ readonly id: TurnId; items: Array<unknown> }> = [];
      let current: { readonly id: TurnId; items: Array<unknown> } | undefined;
      for (const node of chain) {
        if (node.entry.type !== "message" && node.entry.type !== "custom_message") {
          yield* Effect.logDebug("omo.readThread.entry.skipped", {
            provider: PROVIDER,
            threadId,
            entryId: node.entry.id,
            entryType: node.entry.type,
          });
          continue;
        }
        const projectedEntry = markOmoMonitorEvent(node.raw);
        if (node.entry.type === "message" && extractRole(node.entry.message) === "user") {
          current = { id: TurnId.make(`omo-turn-${node.entry.id}`), items: [projectedEntry] };
          turns.push(current);
          continue;
        }
        if (current === undefined) {
          current = { id: TurnId.make("omo-turn-initial"), items: [] };
          turns.push(current);
        }
        current.items.push(projectedEntry);
      }

      return {
        threadId,
        turns: turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
      };
    },
  );

  const rollbackThread: OmoAdapterShape["rollbackThread"] = () =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "omo does not support conversation rollback",
      }),
    );

  const sendSubagentMessage: NonNullable<OmoAdapterShape["sendSubagentMessage"]> = Effect.fn(
    "OmoAdapter.sendSubagentMessage",
  )(function* (threadId, input) {
    const context = yield* requireSession(threadId);
    return yield* sendOmoTaskMessage(context.handle, input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/send",
            detail: runtimeErrorDetail(cause),
            cause,
          }),
      ),
    );
  });

  const cancelSubagentTask: NonNullable<OmoAdapterShape["cancelSubagentTask"]> = Effect.fn(
    "OmoAdapter.cancelSubagentTask",
  )(function* (threadId, input) {
    const context = yield* requireSession(threadId);
    return yield* sendOmoTaskCancel(context.handle, input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/cancel",
            detail: runtimeErrorDetail(cause),
            cause,
          }),
      ),
    );
  });

  const readSubagentOutput: NonNullable<OmoAdapterShape["readSubagentOutput"]> = Effect.fn(
    "OmoAdapter.readSubagentOutput",
  )(function* (threadId, input) {
    const context = yield* requireSession(threadId);
    return yield* sendOmoTaskOutput(context.handle, input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/output",
            detail: runtimeErrorDetail(cause),
            cause,
          }),
      ),
    );
  });

  const stopAll: OmoAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopContext, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue)), Effect.ignore),
  );

  return {
    provider: PROVIDER,
    sharedProcess: shared,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    setSessionModel,
    sendSubagentMessage,
    cancelSubagentTask,
    readSubagentOutput,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } satisfies OmoAdapterShape;
});
