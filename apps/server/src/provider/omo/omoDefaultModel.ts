/**
 * Omo live default model resolution.
 *
 * Omo persists the user's configured default under
 * `<coding-agent-dir>/settings.json` as `{ defaultProvider, defaultModel }`.
 * `get_available_models` returns models sorted alphabetically and carries no
 * default marker, so the app must read that settings file to know which model
 * the user actually defaults to. Resolution is lenient: any read/parse failure
 * degrades to "no live default", letting callers fall back to the static slug.
 *
 * @module provider/omo/omoDefaultModel
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import {
  nonEmptyTrimmed,
  readOmoAgentSettings,
  resolveOmoCodingAgentDir,
  type OmoAgentSettings,
} from "./omoAgentSettings.ts";
import { encodeOmoModelSlug, type OmoModelRef } from "./omoMappers.ts";

export { resolveOmoCodingAgentDir };

export const omoDefaultModelRefFromSettings = (
  settings: OmoAgentSettings,
): Option.Option<OmoModelRef> => {
  const provider = nonEmptyTrimmed(settings.defaultProvider);
  const modelId = nonEmptyTrimmed(settings.defaultModel);
  return provider === undefined || modelId === undefined
    ? Option.none()
    : Option.some({ provider, modelId });
};

export const readOmoDefaultModelRef = (
  environment: NodeJS.ProcessEnv,
): Effect.Effect<Option.Option<OmoModelRef>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.map(readOmoAgentSettings(environment), (settings) =>
    Option.flatMap(settings, omoDefaultModelRefFromSettings),
  );

/**
 * Reorders `models` so the omo settings default leads the list AND stamps
 * it `isDefault: true`, so the web layer's `models.find((m) => m.isDefault)`
 * resolves the same model omo itself defaults to. Every other model loses
 * `isDefault` (the key is omitted, mirroring the I2 strip rule documented on
 * `applyOmoThinkingLevelDefault` in omoSettingsProjection.ts): when the
 * settings default is absent or matches no discovered model, NO model may
 * keep a stale `isDefault` from a prior projection, so a live-watcher
 * re-projection after the user edits settings.json can never surface two
 * flagged models. Inputs are never mutated; models needing no change keep
 * referential identity, and the input array itself is returned when nothing
 * changed.
 */
export const orderModelsByOmoDefault = (
  models: ReadonlyArray<ServerProviderModel>,
  defaultRef: Option.Option<OmoModelRef>,
): ReadonlyArray<ServerProviderModel> => {
  const slug = Option.isNone(defaultRef) ? undefined : encodeOmoModelSlug(defaultRef.value);
  const targetIndex = slug === undefined ? -1 : models.findIndex((model) => model.slug === slug);

  let changed = false;
  const stamped = models.map((model, index) => {
    if (index === targetIndex) {
      if (model.isDefault === true) return model;
      changed = true;
      return { ...model, isDefault: true };
    }
    if (model.isDefault === undefined) return model;
    changed = true;
    const { isDefault: _isDefault, ...stripped } = model;
    return stripped;
  });

  if (targetIndex <= 0) return changed ? stamped : models;
  const target = stamped[targetIndex];
  if (target === undefined) return models;
  return [target, ...stamped.filter((_, index) => index !== targetIndex)];
};
