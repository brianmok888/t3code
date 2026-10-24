/**
 * Thread-scoped omo session stats and compaction relay.
 *
 * Three commands ride a live omo session handle:
 *   - `omo.stats.get`         → `get_session_stats`, answered ON DEMAND.
 *   - `omo.compact.run`       → `compact`, returning the result summary and
 *                                 emitting a completion notification.
 *   - `omo.autoCompaction.set`→ `set_auto_compaction`, whose current value is
 *                                 projected from the session state carried by
 *                                 the following `get_state` refresh.
 *
 * Every function takes the handle's `send` rather than the handle so callers
 * (adapter, tests) inject their own transport and the module never widens an
 * Effect requirements channel. There is deliberately NO polling here: omo
 * never pushes stats, so a cadence would only add wire traffic the UI cannot
 * consume — todo 21 fetches on user demand and nowhere else.
 *
 * @module provider/omo/omoSessionStats
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  OmoRpcSessionState,
  OmoSessionHandleProtocolError,
  type OmoSuccessfulResponse,
} from "../Layers/OmoSessionHandle.ts";
import {
  OmoSessionStatsData,
  type OmoCommand,
  type OmoSessionStatsData as OmoSessionStats,
} from "./omoRpcProtocol.ts";

/** Client-facing command ids relayed onto the omo wire. */
export const OMO_STATS_GET_COMMAND = "omo.stats.get";
export const OMO_COMPACT_RUN_COMMAND = "omo.compact.run";
export const OMO_AUTO_COMPACTION_SET_COMMAND = "omo.autoCompaction.set";

/**
 * A user-visible relay notification. `severity` maps 1:1 onto the runtime
 * warning payload's severity, so a failed compaction surfaces as a provider
 * error instead of an informational line.
 */
export type OmoSessionNotification = {
  readonly message: string;
  readonly severity: "info" | "error";
  readonly detail?: string;
};

export type OmoCompactionOutcome = {
  /** Human-readable summary when omo reported one, else a stable fallback. */
  readonly summary: string;
  /** Untouched `CompactionResult` passthrough (opaque to this server). */
  readonly result: unknown;
};

type SendCommand<E> = (command: OmoCommand) => Effect.Effect<OmoSuccessfulResponse, E>;

const decodeStats = Schema.decodeUnknownEffect(OmoSessionStatsData);
const decodeSessionState = Schema.decodeUnknownEffect(OmoRpcSessionState);

const protocolError = (cause: unknown): OmoSessionHandleProtocolError =>
  new OmoSessionHandleProtocolError({ detail: String(cause) });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** omo's `CompactionResult.summary` when present; never invented. */
const compactionSummary = (result: unknown): string => {
  if (!isRecord(result)) return "Omo compacted the session context.";
  const summary = result.summary;
  if (typeof summary !== "string") return "Omo compacted the session context.";
  const trimmed = summary.trim();
  return trimmed.length === 0 ? "Omo compacted the session context." : trimmed;
};

/**
 * `omo.stats.get` — issues `get_session_stats` once per call.
 *
 * The payload is a passthrough struct: the token/cost fields the UI renders are
 * typed and every other omo-side field survives untouched, so new upstream
 * counters reach clients without a schema bump here.
 */
export const getOmoSessionStats = <E>(input: {
  readonly send: SendCommand<E>;
}): Effect.Effect<OmoSessionStats, E | OmoSessionHandleProtocolError> =>
  input
    .send({ type: "get_session_stats" })
    .pipe(
      Effect.flatMap((response) => decodeStats(response.data).pipe(Effect.mapError(protocolError))),
    );

/**
 * `omo.compact.run` — issues `compact` and reports the outcome.
 *
 * Both terminal paths notify: success emits the summary at `info`, and a wire
 * failure emits a provider-error notification before re-failing. The session is
 * left untouched either way — a rejected compaction is not a session fault, so
 * later commands on the same handle keep working.
 */
export const runOmoCompaction = <E>(input: {
  readonly send: SendCommand<E>;
  readonly customInstructions?: string;
  readonly notify: (notification: OmoSessionNotification) => Effect.Effect<void>;
}): Effect.Effect<OmoCompactionOutcome, E> =>
  input
    .send({
      type: "compact",
      ...(input.customInstructions === undefined
        ? {}
        : { customInstructions: input.customInstructions }),
    })
    .pipe(
      Effect.flatMap((response) => {
        const summary = compactionSummary(response.data);
        return input
          .notify({
            message: "Compacted the omo session context.",
            severity: "info",
            detail: summary,
          })
          .pipe(Effect.as({ summary, result: response.data } satisfies OmoCompactionOutcome));
      }),
      Effect.tapError((cause) =>
        input.notify({
          message: "Omo failed to compact the session context.",
          severity: "error",
          detail: String(cause),
        }),
      ),
    );

/**
 * `omo.autoCompaction.set` — issues `set_auto_compaction` and answers with the
 * value omo actually holds afterwards.
 *
 * The response is success-only, so the new value comes from the `get_state`
 * refresh that follows: omo is the source of truth for the toggle, and
 * echoing the request would report a state the agent may have clamped.
 */
export const setOmoAutoCompaction = <E>(input: {
  readonly send: SendCommand<E>;
  readonly enabled: boolean;
}): Effect.Effect<boolean, E | OmoSessionHandleProtocolError> =>
  input.send({ type: "set_auto_compaction", enabled: input.enabled }).pipe(
    Effect.andThen(() => input.send({ type: "get_state" })),
    Effect.flatMap((response) =>
      decodeSessionState(response.data).pipe(
        Effect.mapError(protocolError),
        Effect.map(projectOmoAutoCompaction),
      ),
    ),
  );

/** Projects the thread-runtime auto-compaction slice off a session-state refresh. */
export const projectOmoAutoCompaction = (state: OmoRpcSessionState): boolean =>
  state.autoCompactionEnabled;
