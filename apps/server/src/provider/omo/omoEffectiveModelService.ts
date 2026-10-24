import type {
  ProviderInstanceId,
  OmoAuthCommandError,
  OmoGetEffectiveModelResult,
} from "@t3tools/contracts";
import { OmoEffectiveModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import {
  resolveOmoSupervisor,
  omoCommandError,
  withOmoControlSession,
} from "./omoControlSession.ts";

const decodeEffectiveModel = Schema.decodeUnknownEffect(OmoEffectiveModel);

export const getOmoEffectiveModel = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  instanceId: ProviderInstanceId | undefined,
): Effect.Effect<OmoGetEffectiveModelResult, OmoAuthCommandError> =>
  Effect.gen(function* () {
    const target = yield* resolveOmoSupervisor(getByInstance, instanceId);
    return yield* withOmoControlSession(target.supervisor, (opened) =>
      Effect.gen(function* () {
        const model =
          opened.state.model === undefined || opened.state.model === null
            ? null
            : yield* decodeEffectiveModel(opened.state.model).pipe(
                Effect.mapError((error) => omoCommandError("invalid_response", error.message)),
              );
        return {
          instanceId: target.instanceId,
          model,
          source: "open_session" as const,
        };
      }),
    );
  });
