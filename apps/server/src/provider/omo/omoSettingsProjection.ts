/**
 * Projection of omo's agent settings onto provider snapshot models.
 *
 * One pure projection (`projectOmoAgentSettings`) derives the two
 * settings-driven snapshot fields — default-model ordering and provider
 * favorites — so the probe path (`checkProvider`) and the live-sync path
 * (`makeOmoAgentSettingsEnrichment`) can never drift apart. The enrichment
 * re-reads `<coding-agent-dir>/settings.json` on every debounced watcher
 * tick and republishes the current snapshot with freshly projected fields,
 * giving hot-reload semantics without re-spawning the omo probe. The
 * managed provider's equality gate swallows no-op republishes.
 *
 * @module provider/omo/omoSettingsProjection
 */
import type {
  ProviderOptionDescriptor,
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  readOmoAgentSettings,
  type OmoAgentSettings,
  watchOmoAgentSettings,
} from "./omoAgentSettings.ts";
import { orderModelsByOmoDefault, omoDefaultModelRefFromSettings } from "./omoDefaultModel.ts";
import { decodeOmoModelSlug } from "./omoMappers.ts";
import { resolveOmoFavoriteModelSlugs } from "./omoFavorites.ts";
import type { OmoThinkingLevel } from "./omoRpcProtocol.ts";
import {
  clampThinkingLevel,
  sanitizeThinkingLevelSelection,
  THINKING_LEVEL_OPTION_ID,
} from "./omoThinkingLevels.ts";

export interface OmoAgentSettingsProjection {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly favoriteModelSlugs: ReadonlyArray<string>;
}

/**
 * Reads the raw `defaultThinkingLevel` from omo agent settings and
 * normalizes it into a ladder member, or `undefined` when the setting is
 * absent, blank, non-string, or not a recognized level. The raw value is
 * `Schema.Unknown` on purpose (see `omoAgentSettings.ts`): a malformed
 * thinking level must never poison the rest of the decoded settings, so
 * normalization happens here at the use site, not in the schema.
 */
const resolveThinkingLevelValue = (raw: unknown): OmoThinkingLevel | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? sanitizeThinkingLevelSelection(trimmed) : undefined;
};

const resolveDefaultThinkingLevel = (
  settings: Option.Option<OmoAgentSettings>,
): OmoThinkingLevel | undefined =>
  resolveThinkingLevelValue(Option.getOrUndefined(settings)?.defaultThinkingLevel);

const resolveModelThinkingLevel = (
  settings: Option.Option<OmoAgentSettings>,
  modelSlug: string,
): OmoThinkingLevel | undefined => {
  const rawMap = Option.getOrUndefined(settings)?.modelThinkingLevels;
  if (typeof rawMap !== "object" || rawMap === null || Array.isArray(rawMap)) return undefined;
  const ref = decodeOmoModelSlug(modelSlug);
  if (Result.isFailure(ref)) return undefined;
  const modelKey = `${ref.success.provider}/${ref.success.modelId}`;
  return resolveThinkingLevelValue((rawMap as Readonly<Record<string, unknown>>)[modelKey]);
};

/**
 * Rebuilds a `thinkingLevel` select descriptor so the clamped default level
 * is marked `isDefault: true` and surfaced as `currentValue`. Every other
 * option loses `isDefault` (the descriptor is default-free until this
 * projection applies exactly one default). The descriptor is rebuilt
 * immutably; the input descriptor and its options are never mutated.
 *
 * `shared/model.ts` exposes no helper that sets `isDefault`/`currentValue`
 * on a descriptor (its `withDescriptorCurrentValue` is private and only
 * resolves a `currentValue` from a raw selection, never `isDefault`), so we
 * spread into a fresh descriptor here. Omo is the source of truth for
 * the thinking-level default (I2): a saved preference alone is not enough —
 * it must clamp to the descriptor's available levels, and an absent/invalid
 * setting leaves the descriptor default-free.
 */
const withThinkingLevelDefault = (
  descriptor: SelectProviderOptionDescriptor,
  level: OmoThinkingLevel,
): SelectProviderOptionDescriptor => {
  const availableLevels = descriptor.options
    .map((option) => sanitizeThinkingLevelSelection(option.id))
    .filter((id): id is OmoThinkingLevel => id !== undefined);
  const clamped = clampThinkingLevel(availableLevels, level);
  return {
    ...descriptor,
    currentValue: clamped,
    options: descriptor.options.map((option) =>
      option.id === clamped ? { ...option, isDefault: true } : { ...option, isDefault: false },
    ),
  };
};

/**
 * Rebuilds a `thinkingLevel` select descriptor so it is default-free:
 * `currentValue` is omitted and every option's `isDefault` is omitted. The
 * descriptor and its options are rebuilt immutably; the inputs are never
 * mutated. Used when `resolveDefaultThinkingLevel` returns `undefined`
 * (absent/blank/non-string/unrecognized setting) so that stale
 * `currentValue`/`isDefault` stamped by a prior projection run cannot
 * survive a live-watcher re-projection (I2: omo is the source of truth,
 * an absent setting must leave the descriptor default-free, not stale).
 */
const stripThinkingLevelDefault = (
  descriptor: SelectProviderOptionDescriptor,
): SelectProviderOptionDescriptor => {
  const { currentValue: _currentValue, ...withoutCurrentValue } = descriptor;
  return {
    ...withoutCurrentValue,
    options: descriptor.options.map(({ isDefault: _isDefault, ...option }) => option),
  };
};

/**
 * Applies the omo `defaultThinkingLevel` setting to every model whose
 * capabilities carry a `thinkingLevel` select descriptor. Pure function of
 * `(models, settings)`: same inputs always produce the same output, and no
 * stale default can accumulate because each model's descriptor is rebuilt
 * from scratch (never merged onto a previously-defaulted descriptor).
 *
 * When `resolveDefaultThinkingLevel` returns `undefined` (absent/blank/
 * non-string/unrecognized), the function does NOT short-circuit: it
 * actively strips any `currentValue` and `isDefault` previously stamped on
 * every model's `thinkingLevel` descriptor, so a live-watcher re-projection
 * of already-defaulted models produces a default-free descriptor rather
 * than carrying stale defaults through unchanged (I2).
 */
const applyOmoThinkingLevelDefault = (
  models: ReadonlyArray<ServerProviderModel>,
  settings: Option.Option<OmoAgentSettings>,
): ReadonlyArray<ServerProviderModel> => {
  const globalLevel = resolveDefaultThinkingLevel(settings);
  return models.map((model) => {
    const level = resolveModelThinkingLevel(settings, model.slug) ?? globalLevel;
    if (level === undefined) return stripThinkingLevelFromModel(model);
    const capabilities = model.capabilities;
    if (capabilities === null) return model;
    const descriptors = capabilities.optionDescriptors;
    if (descriptors === undefined || descriptors.length === 0) return model;

    let mutated = false;
    const nextDescriptors: ReadonlyArray<ProviderOptionDescriptor> = descriptors.map(
      (descriptor) => {
        if (descriptor.type === "select" && descriptor.id === THINKING_LEVEL_OPTION_ID) {
          mutated = true;
          return withThinkingLevelDefault(descriptor, level);
        }
        return descriptor;
      },
    );
    return mutated ? { ...model, capabilities: { optionDescriptors: nextDescriptors } } : model;
  });
};

/**
 * Strips any stale `currentValue`/`isDefault` from a model's `thinkingLevel`
 * select descriptor. Returns the model unchanged when it has no
 * capabilities, no descriptors, or no `thinkingLevel` select descriptor
 * (referential identity preserved). Otherwise rebuilds the descriptor via
 * `stripThinkingLevelDefault` and returns a new model.
 */
const stripThinkingLevelFromModel = (model: ServerProviderModel): ServerProviderModel => {
  const capabilities = model.capabilities;
  if (capabilities === null) return model;
  const descriptors = capabilities.optionDescriptors;
  if (descriptors === undefined || descriptors.length === 0) return model;

  let mutated = false;
  const nextDescriptors: ReadonlyArray<ProviderOptionDescriptor> = descriptors.map((descriptor) => {
    if (descriptor.type === "select" && descriptor.id === THINKING_LEVEL_OPTION_ID) {
      mutated = true;
      return stripThinkingLevelDefault(descriptor);
    }
    return descriptor;
  });
  return mutated ? { ...model, capabilities: { optionDescriptors: nextDescriptors } } : model;
};

export const projectOmoAgentSettings = (
  models: ReadonlyArray<ServerProviderModel>,
  settings: Option.Option<OmoAgentSettings>,
): OmoAgentSettingsProjection => {
  const ordered = orderModelsByOmoDefault(
    models,
    Option.flatMap(settings, omoDefaultModelRefFromSettings),
  );
  return {
    models: applyOmoThinkingLevelDefault(ordered, settings),
    favoriteModelSlugs: resolveOmoFavoriteModelSlugs(
      Option.getOrUndefined(settings)?.favoriteModels ?? [],
      models,
    ),
  };
};

export const makeOmoAgentSettingsEnrichment =
  (environment: NodeJS.ProcessEnv) =>
  ({
    getSnapshot,
    publishSnapshot,
  }: {
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    Stream.runForEach(watchOmoAgentSettings(environment), () =>
      Effect.gen(function* () {
        const settings = yield* readOmoAgentSettings(environment);
        const current = yield* getSnapshot;
        yield* publishSnapshot({
          ...current,
          ...projectOmoAgentSettings(current.models, settings),
        });
      }).pipe(Effect.ignoreCause({ log: true })),
    );
