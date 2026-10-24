/**
 * What model a RESUMED omo session must end up on.
 *
 * senpi's RPC registry restores a resumed session's persisted model and
 * DISCARDS the caller's `creationModel` (`dist/modes/rpc/session-registry.js`,
 * "Resume vs create parity"). The desktop therefore cannot express a resumed
 * thread's model through `open_session` at all: the engine will silently run
 * whatever the transcript last recorded, which for an adopted CLI session may
 * be a model the thread never displayed and the catalog no longer resolves.
 *
 * This module answers the one question that follows — given what the thread
 * claims and what the provider OBSERVABLY restored, is a `set_model` needed —
 * and nothing else. It never reads catalogs and never decides ordering; the
 * adapter owns issuing the command before the first prompt and owns leaving
 * the applied-model cache untouched until that command succeeds.
 *
 * @module provider/omo/omoResumedModelReconciliation
 */
import * as Result from "effect/Result";

import { decodeOmoModelSlug, type OmoModelRef } from "./omoMappers.ts";

export type ResumedModelPlan =
  /** The engine already runs the thread's model, or the thread names none. */
  | { readonly kind: "keep" }
  /** Issue this `set_model` before any prompt reaches the resumed session. */
  | { readonly kind: "set-model"; readonly model: OmoModelRef }
  /** The thread's selection is not a model slug; the caller reports it. */
  | { readonly kind: "undecodable"; readonly reason: string };

export type ResumedModelInput = {
  /** The thread's displayed selection, as a `provider/modelId` slug. */
  readonly threadModel: string | undefined;
  /** The model the provider reported after opening the session. */
  readonly restoredModel: OmoModelRef | undefined;
};

/**
 * A resumed session keeps its restored model only when that model already IS
 * the thread's selection. Anything else - a different model, or an engine that
 * reports none at all - needs the switch, because the thread's displayed model
 * is the promise the UI made to the user.
 */
export const planResumedModelReconciliation = (input: ResumedModelInput): ResumedModelPlan => {
  const requested = input.threadModel?.trim();
  if (requested === undefined || requested.length === 0) return { kind: "keep" };
  const decoded = decodeOmoModelSlug(requested);
  if (Result.isFailure(decoded)) return { kind: "undecodable", reason: decoded.failure.reason };
  const model = decoded.success;
  const restored = input.restoredModel;
  if (
    restored !== undefined &&
    restored.provider === model.provider &&
    restored.modelId === model.modelId
  ) {
    return { kind: "keep" };
  }
  return { kind: "set-model", model };
};
