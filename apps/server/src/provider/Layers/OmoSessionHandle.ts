import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ProviderAdapterProcessError } from "../Errors.ts";
import type { OmoSharedProcess, OmoSharedProcessError } from "../omo/omoRpcConnection.ts";
import {
  OmoResponse,
  type OmoCommand,
  type OmoEvent,
  type OmoThinkingLevel,
  type OmoUiResponse,
} from "../omo/omoRpcProtocol.ts";
import type { OmoModelRef, OmoPermissionPreset } from "../omo/omoMappers.ts";
export const OmoRpcSessionState = Schema.Struct({
  model: Schema.optional(Schema.Struct({ provider: Schema.String, id: Schema.String })),
  thinkingLevel: Schema.String,
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
  steeringMode: Schema.Literals(["all", "one-at-a-time"]),
  followUpMode: Schema.Literals(["all", "one-at-a-time"]),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  sessionName: Schema.optional(Schema.String),
  autoCompactionEnabled: Schema.Boolean,
  messageCount: Schema.Number,
  pendingMessageCount: Schema.Number,
});
export type OmoRpcSessionState = typeof OmoRpcSessionState.Type;

export class OmoResumeMismatch extends Schema.TaggedError<OmoResumeMismatch>()(
  "OmoResumeMismatch",
  {
    expectedSessionId: Schema.String,
    actualSessionId: Schema.String,
    sessionFile: Schema.String,
  },
) {}

export type OmoSuccessfulResponse = Extract<OmoResponse, { readonly success: true }>;

export class OmoSessionHandleProtocolError extends Schema.TaggedError<OmoSessionHandleProtocolError>()(
  "OmoSessionHandleProtocolError",
  { detail: Schema.String },
) {}

export type OmoDialogMethod = "select" | "confirm" | "input";
export type OmoDialogRequest = Extract<
  OmoEvent,
  { readonly type: "extension_ui_request"; readonly method: OmoDialogMethod }
>;

const trimNonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const normalizeOmoDialogQuestion = (
  requestId: ApprovalRequestId,
  event: OmoDialogRequest,
): UserInputQuestion | undefined => {
  const title = trimNonEmpty(event.title);
  switch (event.method) {
    case "select": {
      const options = event.options
        .map(trimNonEmpty)
        .filter((option): option is string => option !== undefined)
        .map((label) => ({ label, description: label }));
      return options.length === 0
        ? undefined
        : {
            id: requestId,
            header: "OmO",
            question: title ?? "Omo request",
            options,
            multiSelect: false,
          };
    }
    case "confirm": {
      const message = trimNonEmpty(event.message);
      const question =
        title === undefined
          ? (message ?? "Omo request")
          : message === undefined
            ? title
            : `${title}: ${message}`;
      return {
        id: requestId,
        header: "OmO",
        question,
        options: [
          { label: "Confirm", description: "Approve this request" },
          { label: "Cancel", description: "Reject this request" },
        ],
        multiSelect: false,
      };
    }
    case "input": {
      const placeholder = trimNonEmpty(event.placeholder);
      return {
        id: requestId,
        header: "OmO",
        question: title ?? placeholder ?? "Omo input",
        options: [{ label: "Answer", description: placeholder ?? title ?? "Answer" }],
        multiSelect: false,
      };
    }
  }
};

export const omoDialogResponse = (
  nativeId: string,
  method: OmoDialogMethod,
  answer: string,
): OmoUiResponse =>
  method === "confirm"
    ? { type: "extension_ui_response", id: nativeId, confirmed: answer === "Confirm" }
    : { type: "extension_ui_response", id: nativeId, value: answer };

const OmoOpenSessionResponse = Schema.Struct({
  sessionId: Schema.String,
  state: OmoRpcSessionState,
});
const decodeOpenSessionResponse = Schema.decodeUnknownEffect(OmoOpenSessionResponse);
const decodeResponse = Schema.decodeUnknownEffect(OmoResponse);

/** Epoch-local routing identity. It is intentionally absent from persisted cursors. */
export type OmoRoutingHandle = {
  readonly epoch: number;
  readonly sessionId: string;
};

export type OmoOpenSessionOptions = {
  readonly sessionFile: string;
  readonly cwd: string;
  readonly permissionPreset: OmoPermissionPreset;
  readonly model: OmoModelRef | undefined;
  readonly thinkingLevel: OmoThinkingLevel | undefined;
  /** Durable resume-cursor identity; never sent as a spawn option. */
  readonly expectedSessionId: string | undefined;
};

export const registerOmoSessionContext = (
  shared: OmoSharedProcess,
  routing: OmoRoutingHandle,
  register: () => void,
  input: { readonly provider: string; readonly threadId: string },
) =>
  shared.registerSession(routing.epoch, register).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterProcessError({
          ...input,
          detail: `omo open_session epoch ${routing.epoch} exited before adapter registration`,
          cause,
        }),
    ),
  );

export type OmoSessionHandle = {
  readonly routing: OmoRoutingHandle;
  readonly durableSessionId: string;
  readonly readiness: OmoRpcSessionState;
  readonly send: (
    command: OmoCommand,
  ) => Effect.Effect<OmoSuccessfulResponse, OmoSharedProcessError | OmoSessionHandleProtocolError>;
  readonly notify: (record: OmoUiResponse) => Effect.Effect<void, OmoSharedProcessError>;
  readonly close: Effect.Effect<void, OmoSharedProcessError>;
};

const responseFor = (shared: OmoSharedProcess, record: Readonly<Record<string, unknown>>) =>
  shared.request(record, "control").pipe(
    Effect.flatMap((raw) =>
      decodeResponse(raw).pipe(
        Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
      ),
    ),
    Effect.map((response) => response as OmoSuccessfulResponse),
  );

const routed = (routing: OmoRoutingHandle, command: OmoCommand): OmoCommand =>
  ({ ...command, sessionId: routing.sessionId }) as OmoCommand;

/**
 * Opens one session through the shared process and binds all later commands to
 * its epoch-local handle. The durable id is intentionally kept separately.
 */
export const openOmoSessionHandle = (
  shared: OmoSharedProcess,
  options: OmoOpenSessionOptions,
): Effect.Effect<
  OmoSessionHandle,
  OmoSharedProcessError | OmoSessionHandleProtocolError | OmoResumeMismatch
> =>
  Effect.gen(function* () {
    const record = yield* shared.request(
      {
        type: "open_session",
        sessionPath: options.sessionFile,
        cwd: options.cwd,
        permissionPreset: options.permissionPreset,
        ...(options.model === undefined
          ? {}
          : { provider: options.model.provider, modelId: options.model.modelId }),
        ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      },
      "open_session",
    );
    // Everything below runs against a session omo has already opened, so its
    // path reservation is held until someone closes it. Failing out without
    // that close strands the reservation for the life of the shared child and
    // every later open of the same session file answers `session_path_in_use`.
    return yield* buildHandle(shared, options, record).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : closeOpenedSessionSilently(shared, routingSessionIdOf(record)),
      ),
    );
  });

/** Best-effort read of the routing handle from an open_session response. */
const routingSessionIdOf = (record: Readonly<Record<string, unknown>>): string | undefined => {
  const data = record.data;
  if (typeof data !== "object" || data === null) return undefined;
  const sessionId = (data as { readonly sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
};

const closeOpenedSessionSilently = (shared: OmoSharedProcess, sessionId: string | undefined) =>
  sessionId === undefined
    ? Effect.void
    : shared
        .request({ type: "close_session", sessionId }, "close_session")
        .pipe(Effect.ignore, Effect.asVoid);

const buildHandle = (
  shared: OmoSharedProcess,
  options: OmoOpenSessionOptions,
  record: Readonly<Record<string, unknown>>,
): Effect.Effect<
  OmoSessionHandle,
  OmoSharedProcessError | OmoSessionHandleProtocolError | OmoResumeMismatch
> =>
  Effect.gen(function* () {
    const response = yield* decodeResponse(record).pipe(
      Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
    );
    if (!response.success || response.data === undefined) {
      return yield* new OmoSessionHandleProtocolError({
        detail: "open_session returned no session state",
      });
    }
    const opened: typeof OmoOpenSessionResponse.Type = yield* decodeOpenSessionResponse(
      response.data,
    ).pipe(
      Effect.mapError((cause) => new OmoSessionHandleProtocolError({ detail: String(cause) })),
    );
    if (
      options.expectedSessionId !== undefined &&
      opened.state.sessionId !== options.expectedSessionId
    ) {
      return yield* new OmoResumeMismatch({
        expectedSessionId: options.expectedSessionId,
        actualSessionId: opened.state.sessionId,
        sessionFile: options.sessionFile,
      });
    }
    const epoch = record.__omoEpoch;
    if (typeof epoch !== "number") {
      return yield* new OmoSessionHandleProtocolError({
        detail: "open_session response was accepted without an epoch",
      });
    }
    const routing = { epoch, sessionId: opened.sessionId } satisfies OmoRoutingHandle;
    return {
      routing,
      durableSessionId: opened.state.sessionId,
      readiness: opened.state,
      send: (command) => responseFor(shared, routed(routing, command)),
      // Native extension UI records are one-way: their `id` identifies the
      // dialog, not a request correlation token, so the supervisor must write
      // them without allocating/replacing an id.
      notify: (record) => shared.notify({ ...record, sessionId: routing.sessionId }),
      close: shared
        .request({ type: "close_session", sessionId: routing.sessionId }, "close_session")
        .pipe(Effect.asVoid),
    } satisfies OmoSessionHandle;
  });
