import type { SelectProviderOptionDescriptor } from "@t3tools/contracts";

import { OMO_THINKING_LEVEL_LADDER, type OmoThinkingLevel } from "./omoRpcProtocol.ts";

export { OMO_THINKING_LEVEL_LADDER };

export const THINKING_LEVEL_OPTION_ID = "thinkingLevel";

export const THINKING_LEVEL_LABELS: Record<OmoThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

type ThinkingLevelFallbackInput = {
  readonly id: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Record<string, string | null>;
};

type WireThinkingInfo = {
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
  readonly supportedThinkingLevels?: unknown;
};

type NormalizedWireThinkingInfo = {
  readonly reasoning: boolean | undefined;
  readonly thinkingLevelMap: Record<string, string | null> | undefined;
  readonly supportedThinkingLevels: ReadonlyArray<string> | undefined;
};

const isOmoThinkingLevel = (value: string): value is OmoThinkingLevel =>
  OMO_THINKING_LEVEL_LADDER.some((level) => level === value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isStringOrNullRecord = (value: unknown): value is Record<string, string | null> =>
  isPlainObject(value) &&
  Object.values(value).every((entry) => typeof entry === "string" || entry === null);

const isReadonlyStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const supportsXhigh = (model: ThinkingLevelFallbackInput): boolean =>
  model.id.includes("gpt-5.2") ||
  model.id.includes("gpt-5.3") ||
  model.id.includes("gpt-5.4") ||
  model.id.includes("gpt-5.5") ||
  model.id.includes("deepseek-v4-pro") ||
  model.id.includes("deepseek-v4-flash") ||
  model.id.includes("opus-4-6") ||
  model.id.includes("opus-4.6") ||
  model.id.includes("opus-4-7") ||
  model.id.includes("opus-4.7") ||
  model.id.includes("opus-4-8") ||
  model.id.includes("opus-4.8");

const supportsMax = (model: ThinkingLevelFallbackInput): boolean =>
  model.id.includes("opus-4-6") ||
  model.id.includes("opus-4.6") ||
  model.id.includes("opus-4-7") ||
  model.id.includes("opus-4.7") ||
  model.id.includes("opus-4-8") ||
  model.id.includes("opus-4.8");

export const sanitizeSupportedThinkingLevels = (
  input: ReadonlyArray<string>,
): ReadonlyArray<OmoThinkingLevel> | undefined => {
  const reportedLevels = new Set(input);
  const supportedLevels = OMO_THINKING_LEVEL_LADDER.filter((level) => reportedLevels.has(level));
  return supportedLevels.length > 0 ? supportedLevels : undefined;
};

export const fallbackSupportedThinkingLevels = (
  model: ThinkingLevelFallbackInput,
): ReadonlyArray<OmoThinkingLevel> => {
  if (!model.reasoning) return ["off"];

  const supportedLevels = OMO_THINKING_LEVEL_LADDER.filter((level) => {
    const mappedLevel = model.thinkingLevelMap?.[level];
    if (mappedLevel === null) return false;
    if (level === "xhigh") return mappedLevel !== undefined || supportsXhigh(model);
    if (level === "max") return mappedLevel !== undefined || supportsMax(model);
    return true;
  });

  return supportedLevels.length > 0 ? supportedLevels : ["off"];
};

export const sanitizeThinkingLevelSelection = (
  value: string | undefined,
): OmoThinkingLevel | undefined =>
  value !== undefined && isOmoThinkingLevel(value) ? value : undefined;

export const normalizeWireThinkingInfo = (raw: WireThinkingInfo): NormalizedWireThinkingInfo => ({
  reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
  thinkingLevelMap: isStringOrNullRecord(raw.thinkingLevelMap) ? raw.thinkingLevelMap : undefined,
  supportedThinkingLevels: isReadonlyStringArray(raw.supportedThinkingLevels)
    ? raw.supportedThinkingLevels
    : undefined,
});

export const supportedThinkingLevelsForModel = (
  wireModel: WireThinkingInfo & { readonly id: string },
): ReadonlyArray<OmoThinkingLevel> | undefined => {
  const normalized = normalizeWireThinkingInfo(wireModel);
  const wireLevels = normalized.supportedThinkingLevels
    ? sanitizeSupportedThinkingLevels(normalized.supportedThinkingLevels)
    : undefined;
  if (wireLevels) return wireLevels;

  const fallbackLevels = fallbackSupportedThinkingLevels({
    id: wireModel.id,
    ...(normalized.reasoning === undefined ? {} : { reasoning: normalized.reasoning }),
    ...(normalized.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: normalized.thinkingLevelMap }),
  });
  return fallbackLevels.length === 1 && fallbackLevels[0] === "off" ? undefined : fallbackLevels;
};

export const clampThinkingLevel = (
  availableLevels: ReadonlyArray<OmoThinkingLevel>,
  requested: OmoThinkingLevel,
): OmoThinkingLevel => {
  const requestedIndex = OMO_THINKING_LEVEL_LADDER.indexOf(requested);
  for (let index = requestedIndex; index >= 0; index -= 1) {
    const level = OMO_THINKING_LEVEL_LADDER[index];
    if (level !== undefined && availableLevels.includes(level)) return level;
  }
  return availableLevels[0] ?? "off";
};

export const buildThinkingLevelDescriptor = (
  levels: ReadonlyArray<OmoThinkingLevel>,
): SelectProviderOptionDescriptor => ({
  type: "select",
  id: THINKING_LEVEL_OPTION_ID,
  label: "Reasoning",
  options: levels.map((level) => ({ id: level, label: THINKING_LEVEL_LABELS[level] })),
});
