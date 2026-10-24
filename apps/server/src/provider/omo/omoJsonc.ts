import type { AgentConfigOmoEdit } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface ParsedOmoConfig {
  readonly values: Record<string, unknown>;
  readonly parseError: string | null;
}

const parseErrorMessage = (errors: ReadonlyArray<ParseError>): string =>
  errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join("; ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseOmoConfig(text: string): ParsedOmoConfig {
  if (text.trim().length === 0) return { values: {}, parseError: null };
  const errors: Array<ParseError> = [];
  const decoded: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    return { values: {}, parseError: parseErrorMessage(errors) };
  }
  if (!isRecord(decoded)) {
    return { values: {}, parseError: "Expected an object at the JSONC root." };
  }
  return { values: { ...decoded }, parseError: null };
}

export function applyOmoConfigEdits(
  text: string,
  edits: ReadonlyArray<AgentConfigOmoEdit>,
): Result.Result<string, string> {
  const initial = text.trim().length === 0 ? "{}\n" : text;
  const parsed = parseOmoConfig(initial);
  if (parsed.parseError !== null) return Result.fail(parsed.parseError);

  let current = initial;
  for (const edit of edits) {
    const value = edit.value === null ? undefined : edit.value;
    current = applyEdits(
      current,
      modify(current, [...edit.path], value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: "\n",
        },
      }),
    );
  }
  return Result.succeed(current);
}
