/**
 * Omo shared-process restart action.
 *
 * The GUI's "Restart omo process" control routes here. Restart always
 * proceeds: `forceRestart` invalidates the running (or starting) epoch through
 * the same path a natural child exit takes, so in-flight turns receive the
 * established crash-tolerance treatment (fail-and-notify) instead of a bespoke
 * drain protocol, and the next session demand respawns the child.
 *
 * @module provider/omo/omoSharedProcessRestart
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  OmoRestartSharedProcessError,
  type OmoRestartSharedProcessResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import { omoSharedProcessOf } from "./omoSharedProcessAccess.ts";

const OMO_DRIVER_KIND = ProviderDriverKind.make("omo");

export const restartOmoSharedProcess = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  instanceId: ProviderInstanceId | undefined,
): Effect.Effect<OmoRestartSharedProcessResult, OmoRestartSharedProcessError> =>
  Effect.gen(function* () {
    const targetInstanceId = instanceId ?? defaultInstanceIdForDriver(OMO_DRIVER_KIND);
    const notOmo = (detail: string) =>
      new OmoRestartSharedProcessError({ reason: "not_omo_instance", detail });
    const adapter = yield* getByInstance(targetInstanceId).pipe(
      Effect.mapError(() =>
        notOmo(`Provider instance "${targetInstanceId}" is not a live omo instance.`),
      ),
    );
    const supervisor = omoSharedProcessOf(adapter);
    if (supervisor === undefined) {
      return yield* notOmo(`Provider instance "${targetInstanceId}" is not a omo instance.`);
    }
    yield* supervisor.forceRestart ?? supervisor.refresh;
    return { status: "restarted", instanceId: targetInstanceId } as const;
  });
