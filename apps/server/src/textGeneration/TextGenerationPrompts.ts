// Port shim (omo fork): t3 v0.1.2 no longer ships TextGenerationPrompts.ts;
// omo-desktop's aux JSON generation imported these builders. Reconstructed
// against the upstream TextGeneration Service signatures so the port stays
// type-aligned with t3's own provider implementations.
import * as Schema from "effect/Schema";
import type * as TextGeneration from "./TextGeneration.ts";

type Service = TextGeneration.TextGeneration["Service"];
export type CommitMessagePromptInput = Parameters<Service["generateCommitMessage"]>[0];
export type PrContentPromptInput = Parameters<Service["generatePrContent"]>[0];
export type BranchNamePromptInput = Parameters<Service["generateBranchName"]>[0];
export type ThreadTitlePromptInput = Parameters<Service["generateThreadTitle"]>[0];

const JSON_ONLY = "Respond with ONLY a JSON object. No markdown fences, no commentary.";

const CommitMessageOutput = Schema.Struct({ subject: Schema.String, body: Schema.String });
const PrContentOutput = Schema.Struct({ title: Schema.String, body: Schema.String });
const BranchNameOutput = Schema.Struct({ branch: Schema.String });
const ThreadTitleOutput = Schema.Struct({ title: Schema.String });

export const buildCommitMessagePrompt = (
  input: CommitMessagePromptInput,
): { prompt: string; outputSchema: typeof CommitMessageOutput } => ({
  prompt: [
    "Write a git commit message for the staged changes.",
    input.includeBranch && input.branch ? `Current branch: ${input.branch}` : "",
    input.policy ? `Repository commit policy:\n${String(input.policy)}` : "",
    "Staged summary:",
    typeof input.stagedSummary === "string" ? input.stagedSummary : "",
    "Staged patch:",
    typeof input.stagedPatch === "string" ? input.stagedPatch : "",
    'Return JSON: {"subject": "<imperative subject, <=72 chars>", "body": "<wrapped body, may be empty>"}',
    JSON_ONLY,
  ]
    .filter(Boolean)
    .join("\n\n"),
  outputSchema: CommitMessageOutput,
});

export const buildPrContentPrompt = (
  input: PrContentPromptInput,
): { prompt: string; outputSchema: typeof PrContentOutput } => ({
  prompt: [
    "Write a pull request title and body for these changes.",
    "Context:",
    JSON.stringify(input, null, 2),
    'Return JSON: {"title": "<concise PR title>", "body": "<markdown body: summary, changes, testing>"}',
    JSON_ONLY,
  ].join("\n\n"),
  outputSchema: PrContentOutput,
});

export const buildBranchNamePrompt = (
  input: BranchNamePromptInput,
): { prompt: string; outputSchema: typeof BranchNameOutput } => ({
  prompt: [
    "Propose a short git branch name for this work.",
    "Context:",
    JSON.stringify(input, null, 2),
    'Return JSON: {"branch": "<kebab-case fragment, e.g. fix-login-race>"}',
    JSON_ONLY,
  ].join("\n\n"),
  outputSchema: BranchNameOutput,
});

export const buildThreadTitlePrompt = (
  input: ThreadTitlePromptInput,
): { prompt: string; outputSchema: typeof ThreadTitleOutput } => ({
  prompt: [
    "Write a short thread title (max ~8 words) summarizing this conversation/task.",
    "Context:",
    JSON.stringify(input, null, 2),
    'Return JSON: {"title": "<title>"}',
    JSON_ONLY,
  ].join("\n\n"),
  outputSchema: ThreadTitleOutput,
});
