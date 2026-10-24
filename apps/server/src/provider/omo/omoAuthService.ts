import {
  type ProviderInstanceId,
  OmoAuthCommandError,
  type OmoAuthMutationResult,
  OmoAuthProvider,
  type OmoGetAuthProvidersResult,
  type OmoGetProviderAccountsResult,
  type OmoLoginStartResult,
  OmoProviderAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import {
  requestOmoControl,
  resolveOmoSupervisor,
  omoCommandError,
  withOmoControlSession,
} from "./omoControlSession.ts";
import type { OmoRpcRecord } from "./omoRpcConnection.ts";
const decodeAuthProvidersData = Schema.decodeUnknownEffect(
  Schema.Struct({ providers: Schema.Array(OmoAuthProvider) }),
);
const decodeProviderAccountsData = Schema.decodeUnknownEffect(
  Schema.Struct({ accounts: Schema.Array(OmoProviderAccount) }),
);

const mutation = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: {
    readonly instanceId?: ProviderInstanceId;
    readonly provider: string;
  },
  command: OmoRpcRecord,
): Effect.Effect<OmoAuthMutationResult, OmoAuthCommandError> =>
  Effect.gen(function* () {
    const target = yield* resolveOmoSupervisor(getByInstance, input.instanceId);
    yield* withOmoControlSession(target.supervisor, ({ sessionId }) =>
      requestOmoControl(target.supervisor, { ...command, sessionId }),
    );
    return {
      instanceId: target.instanceId,
      provider: input.provider,
      status: "ok",
    } as const;
  });

export const getOmoAuthProviders = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  instanceId: ProviderInstanceId | undefined,
): Effect.Effect<OmoGetAuthProvidersResult, OmoAuthCommandError> =>
  Effect.gen(function* () {
    const target = yield* resolveOmoSupervisor(getByInstance, instanceId);
    const response = yield* withOmoControlSession(target.supervisor, ({ sessionId }) =>
      requestOmoControl(target.supervisor, { type: "get_auth_providers", sessionId }),
    );
    const data = yield* decodeAuthProvidersData(response.data).pipe(
      Effect.mapError((error) => omoCommandError("invalid_response", error.message)),
    );
    return { instanceId: target.instanceId, providers: data.providers };
  });

const isLoginEventFor = (record: OmoRpcRecord, provider: string): boolean =>
  record.provider === provider &&
  (record.type === "auth_login_url" || record.type === "auth_login_end");

export const startOmoLogin = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: { readonly instanceId?: ProviderInstanceId; readonly provider: string },
): Effect.Effect<OmoLoginStartResult, OmoAuthCommandError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* resolveOmoSupervisor(getByInstance, input.instanceId);
      const event = yield* withOmoControlSession(target.supervisor, ({ sessionId }) =>
        Effect.gen(function* () {
          const eventFiber = yield* target.supervisor.records.pipe(
            Stream.map(({ record }) => record),
            Stream.filter((record) => isLoginEventFor(record, input.provider)),
            Stream.runHead,
            Effect.timeoutOption("30 seconds"),
            Effect.map(Option.flatten),
            Effect.forkScoped,
          );
          yield* requestOmoControl(target.supervisor, {
            type: "login_start",
            provider: input.provider,
            sessionId,
          });
          return yield* Fiber.join(eventFiber);
        }),
      );
      if (Option.isNone(event)) {
        return yield* omoCommandError(
          "timeout",
          `Omo did not return a login URL for "${input.provider}".`,
        );
      }
      const record = event.value;
      if (record.type === "auth_login_url" && typeof record.url === "string") {
        return {
          instanceId: target.instanceId,
          provider: input.provider,
          status: "url",
          loginUrl: record.url,
        } as const;
      }
      if (record.type === "auth_login_end" && record.success === true) {
        return {
          instanceId: target.instanceId,
          provider: input.provider,
          status: "complete",
        } as const;
      }
      const detail =
        typeof record.error === "string"
          ? record.error
          : `Omo could not authenticate "${input.provider}".`;
      return yield* omoCommandError("login_failed", detail);
    }),
  );

export const cancelOmoLogin = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: { readonly instanceId?: ProviderInstanceId; readonly provider: string },
) => mutation(getByInstance, input, { type: "login_cancel", provider: input.provider });

export const loginOmoApiKey = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: {
    readonly instanceId?: ProviderInstanceId;
    readonly provider: string;
    readonly key: string;
  },
) =>
  mutation(getByInstance, input, {
    type: "login_api_key",
    provider: input.provider,
    key: input.key,
  });

export const logoutOmoProvider = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: { readonly instanceId?: ProviderInstanceId; readonly provider: string },
) => mutation(getByInstance, input, { type: "logout", provider: input.provider });

export const getOmoProviderAccounts = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: { readonly instanceId?: ProviderInstanceId; readonly provider: string },
): Effect.Effect<OmoGetProviderAccountsResult, OmoAuthCommandError> =>
  Effect.gen(function* () {
    const target = yield* resolveOmoSupervisor(getByInstance, input.instanceId);
    const response = yield* withOmoControlSession(target.supervisor, ({ sessionId }) =>
      requestOmoControl(target.supervisor, {
        type: "get_provider_accounts",
        provider: input.provider,
        sessionId,
      }),
    );
    const data = yield* decodeProviderAccountsData(response.data).pipe(
      Effect.mapError((error) => omoCommandError("invalid_response", error.message)),
    );
    return {
      instanceId: target.instanceId,
      provider: input.provider,
      accounts: data.accounts,
    };
  });

export const pinOmoAccount = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: {
    readonly instanceId?: ProviderInstanceId;
    readonly provider: string;
    readonly name: string | null;
  },
) =>
  mutation(getByInstance, input, {
    type: "account_pin",
    provider: input.provider,
    name: input.name,
  });

export const removeOmoAccount = (
  getByInstance: ProviderAdapterRegistryShape["getByInstance"],
  input: {
    readonly instanceId?: ProviderInstanceId;
    readonly provider: string;
    readonly name: string;
  },
) =>
  mutation(getByInstance, input, {
    type: "account_remove",
    provider: input.provider,
    name: input.name,
  });
