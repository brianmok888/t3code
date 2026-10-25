/**
 * Secret-free contracts for Omo provider authentication and account slots.
 *
 * Credential values only ever travel into `OmoLoginApiKeyInput`. Results
 * expose status metadata and account labels, never stored keys or OAuth tokens.
 *
 * @module omoAuth
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const OmoInstanceScope = {
  instanceId: Schema.optionalKey(ProviderInstanceId),
} as const;

export const OmoAuthStatusSource = Schema.Literals([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
  "models_json_headers",
  "extension_headers",
]);
export type OmoAuthStatusSource = typeof OmoAuthStatusSource.Type;

export const OmoAuthStatus = Schema.Struct({
  configured: Schema.Boolean,
  source: Schema.optionalKey(OmoAuthStatusSource),
  label: Schema.optionalKey(Schema.String),
});
export type OmoAuthStatus = typeof OmoAuthStatus.Type;

export const OmoAuthProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  authType: Schema.Literals(["oauth", "api_key"]),
  status: OmoAuthStatus,
});
export type OmoAuthProvider = typeof OmoAuthProvider.Type;

export const OmoProviderAccount = Schema.Struct({
  name: TrimmedNonEmptyString,
  source: Schema.Literals(["login", "import", "env"]),
  blocked: Schema.Boolean,
  pinned: Schema.Boolean,
});
export type OmoProviderAccount = typeof OmoProviderAccount.Type;

export const OmoGetAuthProvidersInput = Schema.Struct(OmoInstanceScope);
export type OmoGetAuthProvidersInput = typeof OmoGetAuthProvidersInput.Type;

export const OmoGetAuthProvidersResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  providers: Schema.Array(OmoAuthProvider),
});
export type OmoGetAuthProvidersResult = typeof OmoGetAuthProvidersResult.Type;

export const OmoGetEffectiveModelInput = Schema.Struct(OmoInstanceScope);
export type OmoGetEffectiveModelInput = typeof OmoGetEffectiveModelInput.Type;

export const OmoEffectiveModel = Schema.Struct({
  provider: TrimmedNonEmptyString,
  id: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OmoEffectiveModel = typeof OmoEffectiveModel.Type;

export const OmoGetEffectiveModelResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: Schema.NullOr(OmoEffectiveModel),
  source: Schema.Literal("open_session"),
});
export type OmoGetEffectiveModelResult = typeof OmoGetEffectiveModelResult.Type;

const OmoProviderInput = Schema.Struct({
  ...OmoInstanceScope,
  provider: TrimmedNonEmptyString,
});

export const OmoLoginStartInput = OmoProviderInput;
export type OmoLoginStartInput = typeof OmoLoginStartInput.Type;

export const OmoLoginStartResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: TrimmedNonEmptyString,
  status: Schema.Literals(["url", "complete"]),
  loginUrl: Schema.optionalKey(Schema.String),
});
export type OmoLoginStartResult = typeof OmoLoginStartResult.Type;

export const OmoLoginCancelInput = OmoProviderInput;
export type OmoLoginCancelInput = typeof OmoLoginCancelInput.Type;

export const OmoLoginApiKeyInput = Schema.Struct({
  ...OmoInstanceScope,
  provider: TrimmedNonEmptyString,
  key: TrimmedNonEmptyString,
});
export type OmoLoginApiKeyInput = typeof OmoLoginApiKeyInput.Type;

export const OmoLogoutInput = OmoProviderInput;
export type OmoLogoutInput = typeof OmoLogoutInput.Type;

export const OmoGetProviderAccountsInput = OmoProviderInput;
export type OmoGetProviderAccountsInput = typeof OmoGetProviderAccountsInput.Type;

export const OmoGetProviderAccountsResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: TrimmedNonEmptyString,
  accounts: Schema.Array(OmoProviderAccount),
});
export type OmoGetProviderAccountsResult = typeof OmoGetProviderAccountsResult.Type;

export const OmoAccountPinInput = Schema.Struct({
  ...OmoInstanceScope,
  provider: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
});
export type OmoAccountPinInput = typeof OmoAccountPinInput.Type;

export const OmoAccountRemoveInput = Schema.Struct({
  ...OmoInstanceScope,
  provider: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type OmoAccountRemoveInput = typeof OmoAccountRemoveInput.Type;

export const OmoAuthMutationResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  provider: TrimmedNonEmptyString,
  status: Schema.Literal("ok"),
});
export type OmoAuthMutationResult = typeof OmoAuthMutationResult.Type;

export class OmoAuthCommandError extends Schema.TaggedError<OmoAuthCommandError>()(
  "OmoAuthCommandError",
  {
    reason: Schema.Literals([
      "not_omo_instance",
      "request_failed",
      "invalid_response",
      "login_failed",
      "timeout",
    ]),
    detail: Schema.String,
  },
) {}
