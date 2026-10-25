import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

// allow: SIZE_OK — schema-heavy wire contract must remain in the plan-mandated protocol module.
export const OMO_THINKING_LEVEL_LADDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const OmoThinkingLevel = Schema.Literals([...OMO_THINKING_LEVEL_LADDER]);
export type OmoThinkingLevel = typeof OmoThinkingLevel.Type;
const OmoImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

/** The subset of a Omo model returned by `set_model` that T3 consumes. */
export const OmoSetModelData = Schema.StructWithRest(
  Schema.Struct({
    provider: Schema.String,
    id: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type OmoSetModelData = typeof OmoSetModelData.Type;

/** Stable multi-session errors. `open_failed` carries an implementation detail suffix. */
export const OMO_STABLE_ERROR_CODES = [
  "unknown_session",
  "session_closing",
  "session_path_in_use",
  "missing_session_id",
  "multi_session_disabled",
  "invalid_path",
] as const;
export type OmoStableErrorCode = (typeof OMO_STABLE_ERROR_CODES)[number] | `open_failed: ${string}`;

const sessionCommandFields = { sessionId: Schema.optional(Schema.String) };

export const OmoCommand = Schema.Union([
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("prompt"),
    message: Schema.String,
    images: Schema.optional(Schema.Array(OmoImageContent)),
    streamingBehavior: Schema.optional(Schema.Literals(["steer", "followUp"])),
    thinkingLevel: Schema.optional(OmoThinkingLevel),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("steer"),
    message: Schema.String,
    images: Schema.optional(Schema.Array(OmoImageContent)),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("follow_up"),
    message: Schema.String,
    images: Schema.optional(Schema.Array(OmoImageContent)),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("abort"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_state"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_available_models"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("set_model"),
    provider: Schema.String,
    modelId: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("set_thinking_level"),
    level: OmoThinkingLevel,
    scope: Schema.optional(Schema.Literal("turn")),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_messages"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_entries"),
    since: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_commands"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_loaded_surfaces"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_session_stats"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("compact"),
    customInstructions: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("set_auto_compaction"),
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_auth_providers"),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("login_start"),
    provider: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("login_cancel"),
    provider: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("login_api_key"),
    provider: Schema.String,
    key: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("logout"),
    provider: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("get_provider_accounts"),
    provider: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("account_pin"),
    provider: Schema.String,
    name: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("account_remove"),
    provider: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    id: Schema.optional(Schema.String),
    type: Schema.Literal("extension_request"),
    name: Schema.String,
    data: Schema.Unknown,
  }),
]);
export type OmoCommand = typeof OmoCommand.Type;

export const OmoUiResponse = Schema.Union([
  Schema.Struct({
    ...sessionCommandFields,
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    ...sessionCommandFields,
    type: Schema.Literal("extension_ui_response"),
    id: Schema.String,
    cancelled: Schema.Literal(true),
  }),
]);
export type OmoUiResponse = typeof OmoUiResponse.Type;

export {
  OmoOpenSessionData,
  OmoRuntimeModel,
  OmoRuntimeSessionState,
} from "./omoSessionProtocol.ts";
export const OmoListSessionsData = Schema.Struct({
  sessions: Schema.Array(
    Schema.Struct({
      sessionId: Schema.String,
      durableSessionId: Schema.String,
      sessionPath: Schema.NullOr(Schema.String),
      cwd: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
      status: Schema.Literals(["opening", "open", "closing", "closed"]),
    }),
  ),
});
export type OmoListSessionsData = typeof OmoListSessionsData.Type;
export const OmoProtocolInfo = Schema.Struct({
  protocolVersion: Schema.Number,
  capabilities: Schema.Array(Schema.String),
  mode: Schema.Literals(["classic", "multi"]),
});
export type OmoProtocolInfo = typeof OmoProtocolInfo.Type;

/** Source metadata for a slash-command row (omo core/source-info.ts SourceInfo). */
export const OmoCommandSourceInfo = Schema.Struct({
  path: Schema.String,
  source: Schema.String,
  scope: Schema.Literals(["user", "project", "temporary"]),
  origin: Schema.Literals(["package", "top-level"]),
  baseDir: Schema.optional(Schema.String),
});
export type OmoCommandSourceInfo = typeof OmoCommandSourceInfo.Type;

/** A command available for invocation via prompt (omo rpc-types.ts RpcSlashCommand). */
export const OmoSlashCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  source: Schema.Literals(["extension", "prompt", "skill"]),
  sourceInfo: OmoCommandSourceInfo,
});
export type OmoSlashCommand = typeof OmoSlashCommand.Type;

/** `get_commands` success payload. */
export const OmoGetCommandsData = Schema.Struct({
  commands: Schema.Array(OmoSlashCommand),
});
export type OmoGetCommandsData = typeof OmoGetCommandsData.Type;

export const OmoLoadedExtension = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  sourceInfo: OmoCommandSourceInfo,
  enabled: Schema.Boolean,
});
export type OmoLoadedExtension = typeof OmoLoadedExtension.Type;

export const OmoMcpServerStatus = Schema.Literals([
  "enabled",
  "disabled",
  "untrusted",
  "idle",
  "connecting",
  "connected",
  "degraded",
  "suspended",
  "needs_auth",
  "needs_client_registration",
]);
export type OmoMcpServerStatus = typeof OmoMcpServerStatus.Type;

export const OmoLoadedMcpServer = Schema.Struct({
  name: Schema.String,
  toolCount: Schema.Number,
  status: OmoMcpServerStatus,
  authStatus: Schema.Literals(["unsupported", "notLoggedIn", "bearerToken", "oAuth"]),
});
export type OmoLoadedMcpServer = typeof OmoLoadedMcpServer.Type;

export const OmoGetLoadedSurfacesData = Schema.Struct({
  extensions: Schema.Array(OmoLoadedExtension),
  mcpServers: Schema.Array(OmoLoadedMcpServer),
});
export type OmoGetLoadedSurfacesData = typeof OmoGetLoadedSurfacesData.Type;

/**
 * `get_session_stats` success payload (omo agent-session.ts SessionStats). The
 * token/cost fields the UI consumes are typed; every other field passes through.
 */
export const OmoSessionStatsData = Schema.StructWithRest(
  Schema.Struct({
    tokens: Schema.optional(
      Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        cacheRead: Schema.Number,
        cacheWrite: Schema.Number,
        total: Schema.Number,
      }),
    ),
    cost: Schema.optional(Schema.Number),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type OmoSessionStatsData = typeof OmoSessionStatsData.Type;

/** `compact` success payload (omo compaction CompactionResult); opaque to T3. */
export const OmoCompactData = Schema.Unknown;
export type OmoCompactData = typeof OmoCompactData.Type;

export const OmoResponse = Schema.Union([
  Schema.Struct({
    id: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(true),
    data: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    id: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(false),
    error: Schema.String,
  }),
]);
export type OmoResponse = typeof OmoResponse.Type;

const KnownAssistantMessageEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
    partial: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
    partial: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_start"),
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_end"),
  }),
  Schema.Struct({
    type: Schema.Literal("text_start"),
    contentIndex: Schema.Number,
    partial: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("text_end"),
    contentIndex: Schema.Number,
    partial: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_start"),
    contentIndex: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_delta"),
    contentIndex: Schema.Number,
    delta: Schema.String,
    partial: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: Schema.Number,
    toolCall: Schema.Struct({
      type: Schema.Literal("toolCall"),
      id: Schema.String,
      name: Schema.String,
      arguments: Schema.Unknown,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("done"),
    reason: Schema.Literals(["stop", "length", "toolUse"]),
    message: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    reason: Schema.Literals(["error", "aborted"]),
    error: Schema.Unknown,
  }),
]);
type KnownAssistantMessageEvent = typeof KnownAssistantMessageEvent.Type;
export type OmoUnknownAssistantMessageEvent = {
  readonly type: "unknown";
  readonly eventType: string;
  readonly payload: unknown;
};
export type OmoAssistantMessageEvent = KnownAssistantMessageEvent | OmoUnknownAssistantMessageEvent;

const emptyEvent = <const Type extends string>(type: Type) =>
  Schema.Struct({ type: Schema.Literal(type) });
const messageEvent = <const Type extends string>(type: Type) =>
  Schema.Struct({ type: Schema.Literal(type), message: Schema.Unknown });
const ExtensionUiRequest = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("select"),
    title: Schema.String,
    options: Schema.Array(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("confirm"),
    title: Schema.String,
    message: Schema.String,
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("input"),
    title: Schema.String,
    placeholder: Schema.optional(Schema.String),
    timeout: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("editor"),
    title: Schema.String,
    prefill: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("notify"),
    message: Schema.String,
    notifyType: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setStatus"),
    statusKey: Schema.String,
    statusText: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setWidget"),
    widgetKey: Schema.String,
    widgetLines: Schema.optional(Schema.Array(Schema.String)),
    widgetPlacement: Schema.optional(Schema.Literals(["aboveEditor", "belowEditor"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("setTitle"),
    title: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("set_editor_text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.Literal("custom_unsupported"),
    extensionName: Schema.String,
  }),
]);

/**
 * Session-entry payloads carried by `entry_appended`. Typed members mirror the
 * omo entry shapes this server consumes; anything else (and any member that
 * fails its own struct) stays an opaque passthrough via the trailing `Unknown`.
 */
export const OmoSessionEntry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("model_change"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    timestamp: Schema.String,
    provider: Schema.String,
    modelId: Schema.String,
    reason: Schema.optional(Schema.Literals(["fallback", "fallback-revert"])),
    originalProvider: Schema.optional(Schema.String),
    originalModelId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    timestamp: Schema.String,
    customType: Schema.Literal("rule-activation"),
    data: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("ttsr"),
        owner: Schema.String,
        rules: Schema.Array(Schema.String),
        remediation: Schema.Literals(["nudge", "provider-error"]),
      }),
      Schema.Struct({
        kind: Schema.Literal("project-rules"),
        targetPath: Schema.String,
        rules: Schema.Array(Schema.String),
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    id: Schema.String,
    parentId: Schema.NullOr(Schema.String),
    timestamp: Schema.String,
    customType: Schema.Literal("ttsr-remediation-error"),
    data: Schema.optional(Schema.Unknown),
  }),
  Schema.Unknown,
]);
export type OmoSessionEntry = typeof OmoSessionEntry.Type;

const KnownOmoEvent = Schema.Union([
  emptyEvent("agent_start"),
  emptyEvent("agent_idle"),
  emptyEvent("loaded_surfaces_changed"),
  Schema.Struct({
    type: Schema.Literal("command_invocation"),
    command: Schema.Struct({
      name: Schema.String,
      source: Schema.Literals(["extension", "prompt"]),
      sourceInfo: OmoCommandSourceInfo,
      syntax: Schema.Literal("slash"),
    }),
  }),
  // Post-bind command-surface invalidation. T3 does not consume the ordered
  // command snapshot (no `get_commands` client here), so the rows stay opaque:
  // a senpi vocabulary addition inside a row must never become a wire error.
  Schema.Struct({
    type: Schema.Literal("commands_changed"),
    commands: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("skill_invocation"),
    skills: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        path: Schema.String,
        syntax: Schema.Literals(["dollar", "slash"]),
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    messages: Schema.Array(Schema.Unknown),
    willRetry: Schema.Boolean,
  }),
  emptyEvent("turn_start"),
  Schema.Struct({
    type: Schema.Literal("turn_end"),
    message: Schema.Unknown,
    toolResults: Schema.Array(Schema.Unknown),
  }),
  messageEvent("message_start"),
  Schema.Struct({
    type: Schema.Literal("message_update"),
    message: Schema.Unknown,
    assistantMessageEvent: Schema.Unknown,
  }),
  messageEvent("message_end"),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    partialResult: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    result: Schema.Unknown,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_event"),
    name: Schema.String,
    data: Schema.Unknown,
  }),
  emptyEvent("agent_settled"),
  Schema.Struct({ type: Schema.Literal("continuation_error"), errorMessage: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_start"),
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    errorMessage: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    attempt: Schema.Number,
    finalError: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("session_info_changed"),
    name: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("entry_appended"),
    entry: OmoSessionEntry,
  }),
  Schema.Struct({ type: Schema.Literal("thinking_level_changed"), level: OmoThinkingLevel }),
  // `reason`/`scope`/`format` are omo vocabulary we never read: keep them lenient
  // strings so a vocabulary addition cannot turn a benign notice into a wire error.
  Schema.Struct({
    type: Schema.Literal("settings_source_selected"),
    path: Schema.String,
    format: Schema.String,
    reason: Schema.String,
    scope: Schema.String,
  }),
  // `model` is a full omo Model object, opaque for the same reason as
  // `system_prompt_change.model` below.
  Schema.Struct({
    type: Schema.Literal("model_changed"),
    model: Schema.Unknown,
    thinkingLevel: OmoThinkingLevel,
    source: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("service_tier_changed"),
    tier: Schema.optional(Schema.String),
    fastMode: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("high_reasoning_warning"),
    modelId: Schema.String,
    provider: Schema.String,
    thinkingLevel: OmoThinkingLevel,
  }),
  Schema.Struct({
    type: Schema.Literal("auth_accounts_changed"),
    provider: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("account_failover"),
    provider: Schema.String,
    from: Schema.String,
    to: Schema.String,
    reason: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("retry_fallback_applied"),
    from: Schema.String,
    to: Schema.String,
    chainKey: Schema.String,
    reason: Schema.Literals(["transient", "refusal", "hard-error", "billing"]),
  }),
  Schema.Struct({
    type: Schema.Literal("retry_fallback_succeeded"),
    model: Schema.String,
    chainKey: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("retry_fallback_reverted"),
    from: Schema.String,
    to: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("retry_fallback_exhausted"),
    chainKey: Schema.String,
    lastError: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("server_fallback_aborted"),
    from: Schema.String,
    to: Schema.String,
    chainConfigured: Schema.Boolean,
  }),
  // `model`/`previousModel` are full omo Model objects, never selector
  // strings: they stay opaque so provider-side shape drift cannot break decode.
  Schema.Struct({
    type: Schema.Literal("system_prompt_change"),
    systemPrompt: Schema.String,
    previousSystemPrompt: Schema.String,
    systemPromptName: Schema.optional(Schema.String),
    model: Schema.Unknown,
    previousModel: Schema.optional(Schema.Unknown),
    source: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("retry_probe_scheduled"),
    selector: Schema.String,
    atMs: Schema.Number,
    probeIndex: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("retry_probe_result"),
    selector: Schema.String,
    ok: Schema.Boolean,
    errorMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("queue_update"),
    steering: Schema.Array(Schema.String),
    followUp: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_start"),
    reason: Schema.String,
    requestId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("compaction_progress"),
    reason: Schema.String,
    delta: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
  }),
  // Lenient: the compaction result and rejection vocabulary evolve provider-side.
  Schema.Struct({
    type: Schema.Literal("compaction_end"),
    reason: Schema.optional(Schema.String),
    result: Schema.optional(Schema.Unknown),
    aborted: Schema.optional(Schema.Boolean),
    willRetry: Schema.optional(Schema.Boolean),
    requestId: Schema.optional(Schema.String),
    accepted: Schema.optional(Schema.Boolean),
    rejectionCause: Schema.optional(Schema.Unknown),
    errorMessage: Schema.optional(Schema.String),
  }),
  emptyEvent("session_abort"),
  Schema.Struct({
    type: Schema.Literal("bash_execution_update"),
    id: Schema.optional(Schema.String),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("summarization_retry_scheduled"),
    attempt: Schema.optional(Schema.Number),
    maxAttempts: Schema.optional(Schema.Number),
    delayMs: Schema.optional(Schema.Number),
    errorMessage: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("summarization_retry_attempt_start"),
    source: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
  emptyEvent("summarization_retry_finished"),
  Schema.Struct({
    type: Schema.Literal("auth_login_url"),
    provider: Schema.String,
    url: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("auth_login_end"),
    provider: Schema.String,
    success: Schema.Boolean,
    error: Schema.optional(Schema.String),
  }),
  ExtensionUiRequest,
  Schema.Struct({
    type: Schema.Literal("extension_error"),
    extensionPath: Schema.String,
    event: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_hook_status"),
    hookRunId: Schema.String,
    hookName: Schema.String,
    toolName: Schema.String,
    toolCallId: Schema.optional(Schema.String),
    extensionPath: Schema.String,
    startedAt: Schema.Number,
    phase: Schema.String,
    statusMessage: Schema.optional(Schema.String),
  }),
]);
type DecodedKnownOmoEvent = typeof KnownOmoEvent.Type;
type OmoMessageUpdateEvent = Omit<
  Extract<DecodedKnownOmoEvent, { readonly type: "message_update" }>,
  "assistantMessageEvent"
> & { readonly assistantMessageEvent: OmoAssistantMessageEvent };
type OmoKnownEvent =
  | Exclude<DecodedKnownOmoEvent, { readonly type: "message_update" }>
  | OmoMessageUpdateEvent;
export type OmoUnknownEvent = {
  readonly type: "unknown";
  readonly eventType: string;
  readonly payload: unknown;
};
/** `sessionId` tags a session-owned output with its epoch-local routing handle. */
export type OmoEvent = (OmoKnownEvent | OmoUnknownEvent) & {
  readonly sessionId?: string;
};
export type OmoInboundRecord = OmoResponse | OmoEvent;

export class OmoWireError extends Schema.TaggedError<OmoWireError>()("OmoWireError", {
  lineNumber: Schema.Number,
  reason: Schema.String,
}) {}

const unionDiscriminants = (schema: { readonly ast: unknown }): readonly string[] => {
  const ast = schema.ast as {
    readonly types?: readonly unknown[];
    readonly members?: readonly unknown[];
  };
  const members = ast.types ?? ast.members ?? [];
  return members.flatMap((member): readonly string[] => {
    const node = member as {
      readonly types?: readonly unknown[];
      readonly members?: readonly unknown[];
      readonly propertySignatures?: readonly {
        readonly name: PropertyKey;
        readonly type?: { readonly literal?: unknown };
      }[];
    };
    if (node.types !== undefined || node.members !== undefined) {
      return unionDiscriminants({ ast: node });
    }
    const literal = node.propertySignatures?.find((property) => property.name === "type")?.type
      ?.literal;
    return typeof literal === "string" ? [literal] : [];
  });
};

/**
 * Derived from `KnownOmoEvent` so the allowlist cannot drift out of lockstep with the schema.
 * Drift previously let malformed payloads degrade to `unknown` instead of erroring.
 */
export const knownEventTypes: ReadonlySet<string> = new Set<string>(
  unionDiscriminants(KnownOmoEvent),
);
const knownAssistantEventTypes: ReadonlySet<string> = new Set([
  "text_delta",
  "text_start",
  "text_end",
  "thinking_delta",
  "thinking_start",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
  "done",
  "error",
] as const);
const WireEnvelope = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
});
const MessageRole = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "toolResult", "custom"]),
});
const MessageStop = Schema.Struct({
  stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]),
  errorMessage: Schema.optional(Schema.String),
});
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const decodeWireEnvelope = Schema.decodeUnknownResult(WireEnvelope);
const decodeKnownEvent = Schema.decodeUnknownResult(KnownOmoEvent);
const decodeKnownAssistantEvent = Schema.decodeUnknownResult(KnownAssistantMessageEvent);
const decodeResponse = Schema.decodeUnknownResult(OmoResponse);
const decodeMessageRole = Schema.decodeUnknownResult(MessageRole);
const decodeMessageStop = Schema.decodeUnknownResult(MessageStop);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const wireError = (lineNumber: number, reason: unknown): OmoWireError =>
  new OmoWireError({ lineNumber, reason: String(reason) });

const decodeAssistantEvent = (
  input: unknown,
  lineNumber: number,
): Result.Result<OmoAssistantMessageEvent, OmoWireError> => {
  const known = decodeKnownAssistantEvent(input);
  if (Result.isSuccess(known)) return Result.succeed(known.success);
  const envelope = decodeWireEnvelope(input);
  if (Result.isFailure(envelope)) return Result.fail(wireError(lineNumber, known.failure));
  if (knownAssistantEventTypes.has(envelope.success.type)) {
    return Result.fail(wireError(lineNumber, known.failure));
  }
  return Result.succeed({
    type: "unknown",
    eventType: envelope.success.type,
    payload: input,
  });
};

const decodeRecord = (
  input: unknown,
  lineNumber: number,
): Result.Result<OmoInboundRecord, OmoWireError> => {
  const envelope = decodeWireEnvelope(input);
  if (Result.isFailure(envelope)) return Result.fail(wireError(lineNumber, envelope.failure));
  if (envelope.success.type === "response") {
    const response = decodeResponse(input);
    return Result.isSuccess(response)
      ? Result.succeed(response.success)
      : Result.fail(wireError(lineNumber, response.failure));
  }
  const event = decodeKnownEvent(input);
  if (Result.isSuccess(event)) {
    const tag =
      envelope.success.sessionId === undefined ? {} : { sessionId: envelope.success.sessionId };
    if (event.success.type !== "message_update")
      return Result.succeed({ ...event.success, ...tag });
    const assistantEvent = decodeAssistantEvent(event.success.assistantMessageEvent, lineNumber);
    return Result.isSuccess(assistantEvent)
      ? Result.succeed({ ...event.success, assistantMessageEvent: assistantEvent.success, ...tag })
      : Result.fail(assistantEvent.failure);
  }
  if (knownEventTypes.has(envelope.success.type)) {
    return Result.fail(wireError(lineNumber, event.failure));
  }
  return Result.succeed({
    type: "unknown",
    eventType: envelope.success.type,
    payload: input,
    ...(envelope.success.sessionId === undefined ? {} : { sessionId: envelope.success.sessionId }),
  });
};

/** Decode one already-parsed shared-process record without incremental framing. */
export const decodeOmoInboundRecord = (
  input: unknown,
): Result.Result<OmoInboundRecord, OmoWireError> => decodeRecord(input, 0);

const decodeLine = (line: string, lineNumber: number): OmoInboundRecord | OmoWireError => {
  const json = decodeJson(line);
  if (Result.isFailure(json)) return wireError(lineNumber, json.failure);
  const record = decodeOmoInboundRecord(json.success);
  return Result.isSuccess(record) ? record.success : record.failure;
};

/** Stateful UTF-8 decoder; mutation is confined to incremental framing state. */
export class OmoJsonlDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private lineNumber = 0;

  write(chunk: Uint8Array): ReadonlyArray<OmoInboundRecord | OmoWireError> {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  end(): ReadonlyArray<OmoInboundRecord | OmoWireError> {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(flush: boolean): ReadonlyArray<OmoInboundRecord | OmoWireError> {
    const records: Array<OmoInboundRecord | OmoWireError> = [];
    let lineStart = 0;
    let newlineIndex = this.buffer.indexOf("\n", lineStart);
    while (newlineIndex !== -1) {
      const rawLine = this.buffer.slice(lineStart, newlineIndex);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.lineNumber += 1;
      records.push(decodeLine(line, this.lineNumber));
      lineStart = newlineIndex + 1;
      newlineIndex = this.buffer.indexOf("\n", lineStart);
    }
    this.buffer = this.buffer.slice(lineStart);
    if (flush && this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.lineNumber += 1;
      records.push(decodeLine(line, this.lineNumber));
    }
    return records;
  }
}

export type OmoStopDetails = {
  readonly stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
  readonly errorMessage: string | undefined;
};

export const extractRole = (
  message: unknown,
): "user" | "assistant" | "toolResult" | "custom" | undefined => {
  const decoded = decodeMessageRole(message);
  return Result.isSuccess(decoded) ? decoded.success.role : undefined;
};

export const extractStopReason = (message: unknown): OmoStopDetails => {
  const decoded = decodeMessageStop(message);
  return Result.isSuccess(decoded)
    ? { stopReason: decoded.success.stopReason, errorMessage: decoded.success.errorMessage }
    : { stopReason: undefined, errorMessage: undefined };
};

export const encodeOmoJsonl = (value: OmoCommand | OmoUiResponse): string =>
  `${encodeJson(value)}\n`;

export type OmoRequestId = `omo_req_${number}`;
export const makeOmoRequestIdAllocator = (): (() => OmoRequestId) => {
  let next = 1;
  return () => `omo_req_${next++}`;
};
