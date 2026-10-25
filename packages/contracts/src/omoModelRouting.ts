import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OMO_AGENT_REQUIREMENTS } from "./omoAgentRequirements.ts";
import { OMO_CATEGORY_REQUIREMENTS } from "./omoCategoryRequirements.ts";

export interface OmoFallbackEntry {
  readonly providers: ReadonlyArray<string>;
  readonly model: string;
  readonly variant?: string;
}

export const OMO_CATEGORY_NAMES = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "architect",
  "unspecified-high",
  "writing",
] as const;

export const OMO_AGENT_NAMES = ["explore", "librarian", "metis", "momus"] as const;

export { OMO_AGENT_REQUIREMENTS, OMO_CATEGORY_REQUIREMENTS };

export const OmoRoutingKind = Schema.Literals(["category", "agent"]);
export type OmoRoutingKind = typeof OmoRoutingKind.Type;

export const OmoModelSource = Schema.Literals(["override", "provider-fallback", "unresolved"]);
export type OmoModelSource = typeof OmoModelSource.Type;

export const OmoModelRoutingRow = Schema.Struct({
  kind: OmoRoutingKind,
  name: TrimmedNonEmptyString,
  selected: Schema.NullOr(TrimmedNonEmptyString),
  selectedAvailable: Schema.NullOr(Schema.Boolean),
  effective: Schema.NullOr(TrimmedNonEmptyString),
  source: OmoModelSource,
  variant: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OmoModelRoutingRow = typeof OmoModelRoutingRow.Type;
