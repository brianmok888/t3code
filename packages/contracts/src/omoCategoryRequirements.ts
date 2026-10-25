import type { OmoFallbackEntry } from "./omoModelRouting.ts";

// Mirrors the native OmO category fallback chains
// (omo packages/senpi-task/src/category/fallback-chains.ts).
export const OMO_CATEGORY_REQUIREMENTS = {
  "visual-engineering": [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "max",
    },
    {
      providers: ["kimi-coding", "kimi-for-coding", "moonshotai", "opencode-go"],
      model: "kimi-k3",
      variant: "max",
    },
    { providers: ["zai-coding-plan", "opencode-go", "vercel"], model: "glm-5.2", variant: "max" },
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    },
  ],
  architect: [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-fable-5",
      variant: "xhigh",
    },
  ],
  ultrabrain: [
    { providers: ["openai", "quotio-openai", "vercel"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "max" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "max" },
  ],
  deep: [
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    },
  ],
  artistry: [
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-fable-5",
      variant: "xhigh",
    },
    {
      providers: ["kimi-coding", "kimi-for-coding", "moonshotai", "opencode-go"],
      model: "kimi-k3",
      variant: "max",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "xhigh",
    },
  ],
  quick: [
    { providers: ["kimi-coding", "kimi-for-coding"], model: "kimi-for-coding-highspeed" },
    { providers: ["quotio-openai"], model: "gpt-5.6-luna-fast", variant: "low" },
    { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "off" },
    {
      providers: [
        "qwen-token-plan",
        "alibaba-token-plan",
        "bailian-coding-plan",
        "opencode-go",
        "vercel",
      ],
      model: "qwen3.6-flash",
      variant: "low",
    },
    { providers: ["opencode-go", "vercel"], model: "minimax-m3", variant: "max" },
    { providers: ["opencode-go", "vercel"], model: "minimax-m2.7", variant: "max" },
    { providers: ["xai"], model: "grok-4.20-0309-non-reasoning" },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "vercel"],
      model: "claude-haiku-4-5",
      variant: "off",
    },
  ],
  "unspecified-low": [
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-terra",
      variant: "high",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-sonnet-5",
      variant: "low",
    },
    {
      providers: [
        "qwen-token-plan",
        "alibaba-token-plan",
        "qwen-token-plan-cn",
        "alibaba-token-plan-cn",
      ],
      model: "qwen3.8-max-preview",
      variant: "max",
    },
    { providers: ["deepseek", "opencode-go", "vercel"], model: "deepseek-v4-pro", variant: "max" },
    { providers: ["xiaomi", "opencode-go", "vercel"], model: "mimo-v2.5-pro", variant: "max" },
  ],
  "unspecified-high": [
    {
      providers: ["kimi-coding", "kimi-for-coding", "moonshotai", "opencode-go"],
      model: "kimi-k3",
      variant: "max",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "xhigh",
    },
    {
      providers: ["openai", "quotio-openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "high",
    },
  ],
  writing: [
    {
      providers: ["kimi-coding", "kimi-for-coding", "moonshotai", "opencode-go"],
      model: "kimi-k3",
      variant: "low",
    },
    {
      providers: ["anthropic", "anthropic-api", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "low",
    },
    { providers: ["google", "github-copilot", "opencode", "vercel"], model: "gemini-3.1-pro" },
  ],
} as const satisfies Readonly<Record<string, ReadonlyArray<OmoFallbackEntry>>>;
