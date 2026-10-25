// omo fork additions extracted from omo-desktop contracts/src/settings.ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeBinaryPathSetting, makeProviderSettingsSchema } from "./settings.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OmoSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("omo").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the omo binary used by this instance.",
        providerSettingsForm: { placeholder: "omo", clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["binaryPath"],
  },
);

export type OmoSettings = typeof OmoSettings.Type;

// from omo-desktop contracts/src/server.ts
export const ServerProviderMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  toolCount: NonNegativeInt,
  status: ServerProviderMcpStatus,
});

export type ServerProviderMcpServer = typeof ServerProviderMcpServer.Type;

export class OmoUpdateFavoriteModelsError extends Schema.TaggedError<OmoUpdateFavoriteModelsError>()(
  "OmoUpdateFavoriteModelsError",
  {
    reason: Schema.Literals(["not_omo_instance", "invalid_model_slug", "write_failed"]),
    detail: Schema.String,
  },
) {}

// from omo-desktop contracts/src/server.ts
export const ServerProviderMcpStatus = Schema.Literals([
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
export type ServerProviderMcpStatus = typeof ServerProviderMcpStatus.Type;
