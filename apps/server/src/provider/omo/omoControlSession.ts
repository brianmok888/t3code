import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  OmoAuthCommandError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { OmoRequestKind, OmoRpcRecord, OmoSharedProcess } from "./omoRpcConnection.ts";
import { omoSharedProcessOf } from "./omoSharedProcessAccess.ts";
import { OmoOpenSessionData } from "./omoSessionProtocol.ts";

const OMO_DRIVER_KIND = ProviderDriverKind.make("omo");
const decodeOpenSessionData = Schema.decodeUnknownEffect(OmoOpenSessionData);

export const omoCommandError = (
  reason: OmoAuthCommandError["reason"],
  detail: string,
): OmoAuthCommandError => new OmoAuthCommandError({ reason, detail });

export const resolveOmoSupervisor = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  instanceId: ProviderInstanceId | undefined,
) =>
  Effect.gen(function* () {
    const targetInstanceId = instanceId ?? defaultInstanceIdForDriver(OMO_DRIVER_KIND);
    const adapter = yield* getByInstance(targetInstanceId).pipe(
      Effect.mapError(() =>
        omoCommandError(
          "not_omo_instance",
          `Provider instance "${targetInstanceId}" is not a live omo instance.`,
        ),
      ),
    );
    const supervisor = omoSharedProcessOf(adapter);
    if (supervisor === undefined) {
      return yield* omoCommandError(
        "not_omo_instance",
        `Provider instance "${targetInstanceId}" is not a omo instance.`,
      );
    }
    return { instanceId: targetInstanceId, supervisor };
  });

export const requestOmoControl = (
  supervisor: OmoSharedProcess,
  command: OmoRpcRecord,
  kind: OmoRequestKind = "control",
): Effect.Effect<OmoRpcRecord, OmoAuthCommandError> =>
  supervisor.request(command, kind).pipe(
    Effect.mapError((error) => omoCommandError("request_failed", error.message)),
    Effect.flatMap((record) => {
      if (record.success === true) return Effect.succeed(record);
      const detail =
        typeof record.error === "string" ? record.error : `Omo rejected ${String(command.type)}.`;
      return Effect.fail(omoCommandError("request_failed", detail));
    }),
  );

export const withOmoControlSession = <A>(
  supervisor: OmoSharedProcess,
  use: (opened: OmoOpenSessionData) => Effect.Effect<A, OmoAuthCommandError, Scope.Scope>,
): Effect.Effect<A, OmoAuthCommandError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        requestOmoControl(supervisor, { type: "open_session" }, "open_session").pipe(
          Effect.flatMap((response) =>
            decodeOpenSessionData(response.data).pipe(
              Effect.mapError((error) => omoCommandError("invalid_response", error.message)),
            ),
          ),
        ),
        (data) =>
          supervisor
            .request({ type: "close_session", sessionId: data.sessionId }, "close_session")
            .pipe(Effect.ignore),
      );
      return yield* use(opened);
    }),
  );
