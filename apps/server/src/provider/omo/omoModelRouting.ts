import {
  OMO_AGENT_NAMES,
  OMO_AGENT_REQUIREMENTS,
  OMO_CATEGORY_NAMES,
  OMO_CATEGORY_REQUIREMENTS,
  type OmoFallbackEntry,
  type OmoModelRoutingRow,
  type OmoRoutingKind,
} from "@t3tools/contracts";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizedModelName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/claude-(opus|sonnet|haiku)-(\d+)[.-](\d+)/g, "claude-$1-$2.$3")
    .replace(/kimi-k2[.-](\d+)/g, "kimi-k2.$1")
    .replace(/\b(glm|gpt)-(\d+)[.-](\d+)/g, "$1-$2.$3");

function inferVercelSubProvider(model: string): string | null {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("grok-")) return "xai";
  if (model.startsWith("minimax-")) return "minimax";
  if (model.startsWith("kimi-") || model.startsWith("k3")) return "moonshotai";
  if (model.startsWith("glm-")) return "zai";
  return null;
}

function transformModelForProvider(provider: string, model: string): string {
  const claudeVersionDot = (value: string) =>
    value.replace(/claude-(\w+)-(\d+)-(\d+)/g, "claude-$1-$2.$3");
  const gatewayTransforms = (value: string) =>
    claudeVersionDot(value).replace(/gemini-3\.1-pro(?!-)/g, "gemini-3.1-pro-preview");
  if (provider === "vercel") {
    const inferredProvider = inferVercelSubProvider(model);
    return inferredProvider === null ? model : `${inferredProvider}/${gatewayTransforms(model)}`;
  }
  if (provider === "github-copilot" || provider === "google") {
    return gatewayTransforms(model).replace(
      /(?<!antigravity-)gemini-3-flash(?!-)/g,
      "gemini-3-flash-preview",
    );
  }
  if ((provider === "kimi-coding" || provider === "kimi-for-coding") && model === "kimi-k3") {
    return "k3";
  }
  return model;
}

function fuzzyMatchModel(
  target: string,
  available: ReadonlyArray<string>,
  provider: string,
): string | null {
  const candidates = available.filter((model) => model.split("/")[0] === provider);
  const targetNormalized = normalizedModelName(target);
  const matches = candidates.filter((model) =>
    normalizedModelName(model).includes(targetNormalized),
  );
  const exact = matches.find((model) => normalizedModelName(model) === targetNormalized);
  if (exact !== undefined) return exact;
  const exactIds = matches.filter(
    (model) => normalizedModelName(model.split("/").slice(1).join("/")) === targetNormalized,
  );
  const pool = exactIds.length > 0 ? exactIds : matches;
  return pool.reduce<string | null>(
    (shortest, current) =>
      shortest === null || current.length < shortest.length ? current : shortest,
    null,
  );
}

function fallback(
  chain: ReadonlyArray<OmoFallbackEntry>,
  availableModels: ReadonlyArray<string>,
): Pick<OmoModelRoutingRow, "effective" | "source" | "variant"> {
  for (const entry of chain) {
    for (const provider of entry.providers) {
      const transformed = transformModelForProvider(provider, entry.model);
      const candidates = transformed === entry.model ? [entry.model] : [entry.model, transformed];
      for (const candidate of candidates) {
        const match = fuzzyMatchModel(candidate, availableModels, provider);
        if (match === null) continue;
        return entry.variant === undefined
          ? { effective: match, source: "provider-fallback" }
          : { effective: match, source: "provider-fallback", variant: entry.variant };
      }
    }
  }
  return { effective: null, source: "unresolved" };
}

function configuredEntry(
  values: Readonly<Record<string, unknown>>,
  kind: OmoRoutingKind,
  name: string,
): Readonly<Record<string, unknown>> | null {
  const collection = values[kind === "category" ? "categories" : "agents"];
  if (!isRecord(collection)) return null;
  const entry = collection[name];
  return isRecord(entry) ? entry : null;
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function row(
  kind: OmoRoutingKind,
  name: string,
  values: Readonly<Record<string, unknown>>,
  availableModels: ReadonlyArray<string>,
  chain: ReadonlyArray<OmoFallbackEntry>,
): OmoModelRoutingRow {
  const entry = configuredEntry(values, kind, name);
  const selected = entry === null ? null : trimmedString(entry.model);
  if (selected !== null && availableModels.includes(selected)) {
    const variant = entry === null ? null : trimmedString(entry.variant);
    return {
      kind,
      name,
      selected,
      selectedAvailable: true,
      effective: selected,
      source: "override",
      ...(variant === null ? {} : { variant }),
    };
  }
  return {
    kind,
    name,
    selected,
    selectedAvailable: selected === null ? null : false,
    ...fallback(chain, availableModels),
  };
}

export function resolveOmoModelRouting(
  values: Readonly<Record<string, unknown>>,
  availableModels: ReadonlyArray<string>,
): ReadonlyArray<OmoModelRoutingRow> {
  return [
    ...OMO_CATEGORY_NAMES.map((name) =>
      row("category", name, values, availableModels, OMO_CATEGORY_REQUIREMENTS[name]),
    ),
    ...OMO_AGENT_NAMES.map((name) =>
      row("agent", name, values, availableModels, OMO_AGENT_REQUIREMENTS[name]),
    ),
  ];
}
