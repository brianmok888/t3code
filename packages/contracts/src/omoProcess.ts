/**
 * Omo shared-process maintenance contracts.
 *
 * Restart is unconditional: in-flight turns receive the same crash-tolerance
 * treatment a natural child exit produces, so the only failure the client has
 * to handle is "this instance is not a live omo instance".
 *
 * @module omoProcess
 */
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

export const OmoRestartSharedProcessInput = Schema.Struct({
  instanceId: Schema.optional(ProviderInstanceId),
});
export type OmoRestartSharedProcessInput = typeof OmoRestartSharedProcessInput.Type;

export const OmoRestartSharedProcessResult = Schema.Struct({
  status: Schema.Literal("restarted"),
  instanceId: ProviderInstanceId,
});
export type OmoRestartSharedProcessResult = typeof OmoRestartSharedProcessResult.Type;

export class OmoRestartSharedProcessError extends Schema.TaggedError<OmoRestartSharedProcessError>()(
  "OmoRestartSharedProcessError",
  {
    reason: Schema.Literals(["not_omo_instance", "restart_failed"]),
    detail: Schema.String,
  },
) {}
