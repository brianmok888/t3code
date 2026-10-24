/**
 * Omo favorite-model resolution and pattern-preserving persistence.
 *
 * Omo stores `favoriteModels` as model patterns in the same format as its
 * `--models` CLI flag (see omo's `core/model-resolver.ts`). This module
 * mirrors that matching semantics against the app's `ServerProviderModel`
 * list so the GUI shows exactly the set omo would cycle through:
 *
 *  - patterns containing glob characters (`*`, `?`, `[`) match
 *    case-insensitively against the full `provider/modelId` id, where `*` and
 *    `?` never cross the `/` separator; when the pattern has no `/` it also
 *    matches against the bare model id;
 *  - other patterns match case-insensitively against the full id — and, only
 *    when the pattern carries no `/`, against the bare model id (omo's
 *    interactive fuzzy substring disambiguation is a picker convenience and
 *    is intentionally not reproduced here — favorites persisted by omo's TUI
 *    are always concrete `provider/modelId` ids, so a provider-qualified
 *    pattern never bare-matches and gateway copies of the same upstream model
 *    stay unfavorited);
 *  - a trailing `[:<serviceTier>][:<thinkingLevel>]` decorator suffix is
 *    stripped before matching, following omo's grammar;
 *  - unmatched patterns are skipped; results follow pattern order, deduped.
 *
 * Writes run the other way: the GUI only speaks concrete models, so
 * `mergeOmoFavoritePatterns` folds a star toggle back onto the stored patterns
 * instead of flattening them (see its doc comment for the exact rules).
 *
 * @module provider/omo/omoFavorites
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  OmoUpdateFavoriteModelsError,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  type OmoAgentSettingsWriteError,
  readOmoAgentSettings,
  writeOmoFavoriteModels,
} from "./omoAgentSettings.ts";
import { decodeOmoModelSlug, type OmoModelSlugError } from "./omoMappers.ts";

// Mirrors OmoThinkingLevel in ./omoRpcProtocol.ts (and omo's rpc-types).
const OMO_THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// Mirrors omo's `ServiceTier` (see its `core/model-resolver.ts`).
const OMO_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "flex", "priority"]);

const GLOB_CHARS = /[*?[]/;
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const globToRegExp = (glob: string): RegExp => {
  let source = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = glob.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
      } else {
        const body = glob.slice(index + 1, end);
        source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end;
      }
    } else {
      source += (char ?? "").replace(REGEXP_SPECIALS, "\\$&");
    }
    index += 1;
  }
  return new RegExp(`^${source}$`, "i");
};

/**
 * Splits an omo favorite pattern into its matchable body and its decorator
 * suffix, following omo's `<model-pattern>[:<auto|flex|priority>][:<level>]`
 * grammar. Decorators are consumed right-to-left, at most one of each kind, so
 * a model id that legitimately ends in a colon segment (OpenRouter's
 * `:exacto`, say) is left untouched.
 */
const splitPatternSuffix = (
  pattern: string,
): { readonly body: string; readonly suffix: string } => {
  let body = pattern;
  let suffix = "";
  let sawThinkingLevel = false;
  let sawServiceTier = false;
  for (;;) {
    const colonIndex = body.lastIndexOf(":");
    if (colonIndex <= 0) break;
    const segment = body.slice(colonIndex + 1);
    if (!sawThinkingLevel && OMO_THINKING_LEVELS.has(segment)) {
      sawThinkingLevel = true;
    } else if (!sawServiceTier && OMO_SERVICE_TIERS.has(segment)) {
      sawServiceTier = true;
    } else {
      break;
    }
    suffix = `:${segment}${suffix}`;
    body = body.slice(0, colonIndex);
  }
  return { body, suffix };
};

const stripPatternSuffix = (pattern: string): string => splitPatternSuffix(pattern).body;

interface MatchableModel {
  readonly slug: string;
  readonly provider: string;
  readonly modelId: string;
  readonly fullId: string;
}

const toMatchableModel = (model: ServerProviderModel): MatchableModel | undefined => {
  const decoded = decodeOmoModelSlug(model.slug);
  if (Result.isFailure(decoded)) return undefined;
  return {
    slug: model.slug,
    provider: decoded.success.provider,
    modelId: decoded.success.modelId,
    fullId: `${decoded.success.provider}/${decoded.success.modelId}`,
  };
};

const matchesPattern = (pattern: string, model: MatchableModel): boolean => {
  const stripped = stripPatternSuffix(pattern);
  if (GLOB_CHARS.test(stripped)) {
    const regex = globToRegExp(stripped);
    return regex.test(model.fullId) || (!stripped.includes("/") && regex.test(model.modelId));
  }
  const needle = stripped.toLowerCase();
  // A pattern containing "/" is provider-qualified by construction (the GUI and
  // omo's TUI only ever persist concrete `provider/modelId` favorites), so it
  // matches the full id alone. Matching its bare modelId too made every gateway
  // instance exposing the same upstream model ("opengateway/anthropic/x") light
  // up as a favorite of "anthropic/x", and un-starring that copy then dropped
  // the user's real pattern through the merge rule.
  return (
    model.fullId.toLowerCase() === needle ||
    (!stripped.includes("/") && model.modelId.toLowerCase() === needle)
  );
};

export const resolveOmoFavoriteModelSlugs = (
  patterns: ReadonlyArray<string>,
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<string> => {
  const matchable = models.flatMap((model) => {
    const candidate = toMatchableModel(model);
    return candidate === undefined ? [] : [candidate];
  });
  const seen = new Set<string>();
  const slugs: Array<string> = [];
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (pattern.length === 0) continue;
    for (const model of matchable) {
      if (!seen.has(model.slug) && matchesPattern(pattern, model)) {
        seen.add(model.slug);
        slugs.push(model.slug);
      }
    }
  }
  return slugs;
};

/**
 * Merges a GUI favorites edit back into omo's stored `favoriteModels`
 * patterns without destroying the ones the user hand-wrote.
 *
 * The GUI only ever speaks in concrete models, so a naive write flattens
 * globs and drops `:tier`/`:thinkingLevel` decorators. This mirrors omo's own
 * `mergeFavoritePatternsForPersist`:
 *
 *  - a stored pattern whose matched models are ALL still requested is kept
 *    VERBATIM (glob shape and decorators intact);
 *  - a stored pattern that matched any now-unfavorited model is dropped; when
 *    it was a glob, its still-favorited matches are re-emitted as concrete
 *    `provider/modelId` entries carrying that pattern's decorator suffix;
 *  - requested models that no kept pattern covers are appended as bare ids, in
 *    request order;
 *  - the result is string-deduped and order-stable (kept patterns first, in
 *    their original order, then the additions).
 *
 * Without a model list (`models === undefined`) patterns cannot be resolved,
 * so the merge degrades conservatively rather than clobbering: a pattern whose
 * suffix-stripped body equals a requested id (case-insensitively) is kept
 * verbatim, a concrete pattern for a no-longer-requested id is dropped, and an
 * unresolvable glob is kept verbatim (its models are also appended, since the
 * glob's coverage is unknown). An empty request always clears the list — the
 * user unstarred everything, so nothing may survive.
 */
export const mergeOmoFavoritePatterns = (options: {
  readonly currentPatterns: ReadonlyArray<string>;
  readonly requestedFullIds: ReadonlyArray<string>;
  readonly models: ReadonlyArray<ServerProviderModel> | undefined;
}): ReadonlyArray<string> => {
  const { currentPatterns, requestedFullIds, models } = options;
  if (requestedFullIds.length === 0) return [];

  const merged: Array<string> = [];
  const mergedSet = new Set<string>();
  const append = (pattern: string): void => {
    if (mergedSet.has(pattern)) return;
    mergedSet.add(pattern);
    merged.push(pattern);
  };

  const requestedByLowerId = new Map<string, string>();
  for (const fullId of requestedFullIds) requestedByLowerId.set(fullId.toLowerCase(), fullId);
  const covered = new Set<string>();

  const matchable =
    models === undefined
      ? undefined
      : models.flatMap((model) => {
          const candidate = toMatchableModel(model);
          return candidate === undefined ? [] : [candidate];
        });

  for (const rawPattern of currentPatterns) {
    const pattern = rawPattern.trim();
    if (pattern.length === 0) continue;
    const { body, suffix } = splitPatternSuffix(pattern);
    const isGlob = GLOB_CHARS.test(body);

    if (matchable === undefined) {
      const requested = requestedByLowerId.get(body.toLowerCase());
      if (requested !== undefined) {
        append(pattern);
        covered.add(requested);
      } else if (isGlob) {
        append(pattern);
      }
      continue;
    }

    // Matched ids are compared in omo's own `provider/modelId` space, which is
    // what both the stored patterns and the request use.
    const matchedIds = matchable
      .filter((model) => matchesPattern(pattern, model))
      .map((model) => model.fullId);
    const survivingIds = matchedIds.flatMap((fullId) => {
      const requested = requestedByLowerId.get(fullId.toLowerCase());
      return requested === undefined ? [] : [requested];
    });

    if (matchedIds.length > 0 && survivingIds.length === matchedIds.length) {
      append(pattern);
      for (const fullId of survivingIds) covered.add(fullId);
      continue;
    }

    // An unresolvable glob may cover models this server cannot see (a provider
    // that is offline right now), so it survives untouched.
    if (matchedIds.length === 0) {
      if (isGlob) append(pattern);
      continue;
    }

    // Edited pattern: re-emit the survivors concretely, keeping its decorators.
    for (const fullId of survivingIds) {
      append(`${fullId}${suffix}`);
      covered.add(fullId);
    }
  }

  for (const fullId of requestedFullIds) {
    if (!covered.has(fullId)) append(fullId);
  }
  return merged;
};

const OMO_DRIVER_KIND = ProviderDriverKind.make("omo");

/**
 * Persists the GUI's resolved favorite set, merged onto the patterns already
 * in omo's settings (see `mergeOmoFavoritePatterns`). `models` is the provider
 * instance's model list; omitting it selects the conservative,
 * resolution-free merge.
 */
export const updateOmoFavoriteModels = (
  environment: NodeJS.ProcessEnv,
  favoriteModelSlugs: ReadonlyArray<string>,
  models?: ReadonlyArray<ServerProviderModel>,
): Effect.Effect<
  ReadonlyArray<string>,
  OmoModelSlugError | OmoAgentSettingsWriteError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const requestedFullIds: Array<string> = [];
    for (const slug of favoriteModelSlugs) {
      const decoded = decodeOmoModelSlug(slug);
      if (Result.isFailure(decoded)) return yield* decoded.failure;
      requestedFullIds.push(`${decoded.success.provider}/${decoded.success.modelId}`);
    }
    const settings = yield* readOmoAgentSettings(environment);
    const currentPatterns = Option.isSome(settings) ? (settings.value.favoriteModels ?? []) : [];
    const patterns = mergeOmoFavoritePatterns({ currentPatterns, requestedFullIds, models });
    yield* writeOmoFavoriteModels(environment, patterns);
    return patterns;
  });

/**
 * Picks the model list the favorites merge should resolve patterns against:
 * the addressed omo instance, or the default omo instance when the caller did
 * not name one. Returns `undefined` when no such snapshot exists (provider not
 * yet probed), which selects the conservative resolution-free merge.
 */
export const resolveOmoFavoriteModelCatalog = (
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly models: ReadonlyArray<ServerProviderModel>;
  }>,
  instanceId: ProviderInstanceId | undefined,
): ReadonlyArray<ServerProviderModel> | undefined => {
  const targetInstanceId = instanceId ?? defaultInstanceIdForDriver(OMO_DRIVER_KIND);
  const provider = providers.find(
    (candidate) =>
      candidate.instanceId === targetInstanceId && candidate.driver === OMO_DRIVER_KIND,
  );
  return provider?.models;
};

export const resolveOmoFavoriteWriteEnvironment = (
  providerInstances: Readonly<Record<string, ProviderInstanceConfig>>,
  hostEnvironment: NodeJS.ProcessEnv,
  instanceId: ProviderInstanceId | undefined,
): Result.Result<NodeJS.ProcessEnv, OmoUpdateFavoriteModelsError> => {
  const defaultOmoInstanceId = defaultInstanceIdForDriver(OMO_DRIVER_KIND);
  const targetInstanceId = instanceId ?? defaultOmoInstanceId;
  const instance = providerInstances[targetInstanceId];
  if (
    instance === undefined
      ? targetInstanceId !== defaultOmoInstanceId
      : instance.driver !== OMO_DRIVER_KIND
  ) {
    return Result.fail(
      new OmoUpdateFavoriteModelsError({
        reason: "not_omo_instance",
        detail: `Provider instance "${targetInstanceId}" is not a omo instance.`,
      }),
    );
  }
  return Result.succeed(mergeProviderInstanceEnvironment(instance?.environment, hostEnvironment));
};
