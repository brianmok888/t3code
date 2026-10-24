// Port shim (omo fork): t3 v0.1.2 no longer ships TextGenerationUtils.ts.
// Only the helpers omo's text generation actually consumes are reconstructed;
// branch-name sanitization comes from @t3tools/shared/git upstream.
import { TextGenerationError } from "@t3tools/contracts";

/** Map a spawn/exec failure to the shared TextGenerationError contract. */
type TextGenOperation = ConstructorParameters<typeof TextGenerationError>[0]["operation"];

export const normalizeCliError = (
  _cli: string,
  operation: TextGenOperation,
  cause: unknown,
  fallback: string,
): TextGenerationError => {
  const detail =
    cause instanceof Error
      ? `${fallback}: ${cause.message}`
      : typeof cause === "string" && cause.length > 0
        ? `${fallback}: ${cause}`
        : `${fallback}.`;
  return new TextGenerationError({ operation, detail, cause });
};

const firstLine = (raw: string): string => raw.split("\n")[0] ?? "";

export const sanitizeCommitSubject = (raw: string): string =>
  firstLine(String(raw ?? ""))
    .replace(/`{1,3}/g, "")
    .replace(/\*+/g, "")
    .replace(/\s+#{1,6}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
    .replace(/[\s.,;:]+$/, "");

export const sanitizePrTitle = (raw: string): string =>
  firstLine(String(raw ?? ""))
    .replace(/`{1,3}/g, "")
    .replace(/\*{1,3}/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/[\s.]+$/, "");

export const sanitizeThreadTitle = (raw: string): string =>
  String(raw ?? "")
    .replace(/["“”'']/g, "")
    .replace(/[`*_[\]]/g, "")
    .replace(/^\s*(?:\d+[.)]|[-•])\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[\s.]+$/, "");
