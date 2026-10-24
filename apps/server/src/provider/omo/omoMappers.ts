import type { RuntimeMode, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  buildThinkingLevelDescriptor,
  supportedThinkingLevelsForModel,
} from "./omoThinkingLevels.ts";

export const OMO_PERMISSION_PRESETS = ["full-access", "workspace", "read-only", "ask"] as const;
export type OmoPermissionPreset = (typeof OMO_PERMISSION_PRESETS)[number];

const PRESET_BY_RUNTIME_MODE = {
  "full-access": "full-access",
  "auto-accept-edits": "workspace",
  // omo exposes no AI-reviewed approval preset, so the auto mode runs with
  // the same workspace confinement as auto-accept-edits.
  auto: "workspace",
  "approval-required": "ask",
} as const satisfies Record<RuntimeMode, OmoPermissionPreset>;

export const omoPermissionPreset = (mode: RuntimeMode): OmoPermissionPreset =>
  PRESET_BY_RUNTIME_MODE[mode];

export class OmoModelSlugError extends Schema.TaggedErrorClass<OmoModelSlugError>()(
  "OmoModelSlugError",
  {
    slug: Schema.String,
    reason: Schema.String,
  },
) {}

export type OmoModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

export const encodeOmoModelSlug = (model: OmoModelRef): string =>
  `${encodeURIComponent(model.provider)}/${model.modelId}`;

export const decodeOmoModelSlug = (slug: string): Result.Result<OmoModelRef, OmoModelSlugError> => {
  const separatorIndex = slug.indexOf("/");
  if (separatorIndex === -1) {
    return Result.fail(new OmoModelSlugError({ slug, reason: "slug has no '/' separator" }));
  }
  const encodedProvider = slug.slice(0, separatorIndex);
  const modelId = slug.slice(separatorIndex + 1);
  try {
    return Result.succeed({ provider: decodeURIComponent(encodedProvider), modelId });
  } catch (error) {
    if (error instanceof URIError) {
      return Result.fail(
        new OmoModelSlugError({
          slug,
          reason: `malformed percent-encoding in provider segment: ${error.message}`,
        }),
      );
    }
    throw error;
  }
};

export type OmoDiscoveredModel = {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Record<string, string | null> | undefined;
  readonly supportedThinkingLevels?: ReadonlyArray<string> | undefined;
};

export const omoModelToServerModel = (model: OmoDiscoveredModel): ServerProviderModel => {
  const slug = encodeOmoModelSlug({ provider: model.provider, modelId: model.id });
  // The picker groups omo models per sub-provider, keyed by the RAW decoded
  // provider id (the slug segment is URI-encoded and must not leak into display).
  // The contract field is optional TrimmedNonEmptyString, so a blank provider
  // omits the key entirely rather than emitting "".
  const subProvider = model.provider.trim();
  const thinkingLevels = supportedThinkingLevelsForModel(model);
  const capabilities =
    thinkingLevels && thinkingLevels.length > 1
      ? createModelCapabilities({
          optionDescriptors: [buildThinkingLevelDescriptor(thinkingLevels)],
        })
      : null;
  return {
    slug,
    name: model.name ?? slug,
    ...(subProvider.length > 0 ? { subProvider } : {}),
    isCustom: false,
    capabilities,
  };
};

export type OmoImageContent = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

export const omoImageContentFromBytes = (bytes: Uint8Array, mimeType: string): OmoImageContent => ({
  type: "image",
  data: Buffer.from(bytes).toString("base64"),
  mimeType,
});
