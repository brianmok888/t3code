import type { OmoFallbackEntry } from "./omoModelRouting.ts";

// Mirrors the native OmO builtin-agent fallback chains
// (omo packages/senpi-task/src/agents/builtin/fallback-chains.ts).
const FAST_RESEARCH = [
  { providers: ["openai"], model: "gpt-5.6-luna-fast", variant: "low" },
  { providers: ["deepseek"], model: "deepseek-v4-flash", variant: "max" },
  { providers: ["opencode-go", "bailian-coding-plan"], model: "qwen3.5-plus" },
  { providers: ["vercel"], model: "minimax-m2.7-highspeed" },
  { providers: ["opencode-go", "vercel"], model: "minimax-m3" },
  { providers: ["minimax-coding-plan", "minimax-cn-coding-plan"], model: "MiniMax-M3" },
  { providers: ["opencode-go", "vercel"], model: "minimax-m2.7" },
  { providers: ["anthropic", "github-copilot", "vercel"], model: "claude-haiku-4-5" },
  { providers: ["openai", "vercel"], model: "gpt-5.4-nano" },
] as const satisfies ReadonlyArray<OmoFallbackEntry>;

export const OMO_AGENT_REQUIREMENTS = {
  explore: FAST_RESEARCH,
  librarian: FAST_RESEARCH,
  metis: [
    {
      providers: ["anthropic", "github-copilot", "opencode", "vercel"],
      model: "claude-sonnet-4-6",
    },
    {
      providers: ["anthropic", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "max",
    },
    {
      providers: ["openai", "github-copilot", "opencode", "vercel"],
      model: "gpt-5.6-sol",
      variant: "medium",
    },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
    { providers: ["kimi-for-coding"], model: "kimi-k3" },
  ],
  momus: [
    { providers: ["openai", "vercel"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["github-copilot"], model: "gpt-5.6-terra", variant: "high" },
    { providers: ["openai", "opencode", "vercel"], model: "gpt-5.6-sol", variant: "xhigh" },
    { providers: ["github-copilot"], model: "gpt-5.6-sol", variant: "high" },
    {
      providers: ["anthropic", "github-copilot", "opencode", "vercel"],
      model: "claude-opus-5",
      variant: "max",
    },
    {
      providers: ["google", "github-copilot", "opencode", "vercel"],
      model: "gemini-3.1-pro",
      variant: "high",
    },
    { providers: ["opencode-go", "vercel"], model: "glm-5.2" },
  ],
} as const satisfies Readonly<Record<string, ReadonlyArray<OmoFallbackEntry>>>;
