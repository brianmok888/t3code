import * as Schema from "effect/Schema";
import type { CheckpointServiceError } from "../checkpointing/Errors.ts";

export class ProviderInstanceNotFoundError extends Schema.TaggedError<ProviderInstanceNotFoundError>()(
  "ProviderInstanceNotFoundError",
  {
    instanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No provider instance bound to id '${this.instanceId}'`;
  }
}

export { ProviderDriverError } from "@t3tools/provider-core/server/errors";

export class ProviderWorkspaceMissingError extends Schema.TaggedError<ProviderWorkspaceMissingError>()(
  "ProviderWorkspaceMissingError",
  {
    threadId: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `This thread's workspace folder no longer exists or is not a directory: ${this.cwd}. Restore the folder at this path before retrying.`;
  }
}

// ── omo fork additions (ported from omo-desktop provider/Errors.ts) ──

/**
 * ProviderAdapterValidationError - Invalid adapter API input.
 */
export class ProviderAdapterValidationError extends Schema.TaggedError<ProviderAdapterValidationError>()(
  "ProviderAdapterValidationError",
  {
    provider: Schema.String,
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter validation failed (${this.provider}) in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderAdapterSessionNotFoundError - Adapter-owned session id is unknown.
 */
export class ProviderAdapterSessionNotFoundError extends Schema.TaggedError<ProviderAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown ${this.provider} adapter thread: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterSessionClosedError - Adapter session exists but is closed.
 */
export class ProviderAdapterSessionClosedError extends Schema.TaggedError<ProviderAdapterSessionClosedError>()(
  "ProviderAdapterSessionClosedError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} adapter thread is closed: ${this.threadId}`;
  }
}

/**
 * ProviderAdapterRequestError - Provider protocol request failed or timed out.
 */
export class ProviderAdapterRequestError extends Schema.TaggedError<ProviderAdapterRequestError>()(
  "ProviderAdapterRequestError",
  {
    provider: Schema.String,
    method: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter request failed (${this.provider}) for ${this.method}: ${this.detail}`;
  }
}

/**
 * ProviderAdapterProcessError - Provider process lifecycle failure.
 */
export class ProviderAdapterProcessError extends Schema.TaggedError<ProviderAdapterProcessError>()(
  "ProviderAdapterProcessError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter process error (${this.provider}) for thread ${this.threadId}: ${this.detail}`;
  }
}

/**
 * ProviderValidationError - Invalid provider API input.
 */
export class ProviderValidationError extends Schema.TaggedError<ProviderValidationError>()(
  "ProviderValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider validation failed in ${this.operation}: ${this.issue}`;
  }
}

/**
 * ProviderUnsupportedError - Requested provider is not implemented.
 */
export class ProviderUnsupportedError extends Schema.TaggedError<ProviderUnsupportedError>()(
  "ProviderUnsupportedError",
  {
    provider: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider '${this.provider}' is not implemented`;
  }
}

/**
 * ProviderSessionNotFoundError - Provider-facing session not found.
 */
export class ProviderSessionNotFoundError extends Schema.TaggedError<ProviderSessionNotFoundError>()(
  "ProviderSessionNotFoundError",
  {
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Unknown provider thread: ${this.threadId}`;
  }
}

/**
 * ProviderSessionDirectoryPersistenceError - Session directory persistence failure.
 */
export class ProviderSessionDirectoryPersistenceError extends Schema.TaggedError<ProviderSessionDirectoryPersistenceError>()(
  "ProviderSessionDirectoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session directory persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type ProviderAdapterError =
  | ProviderAdapterValidationError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError
  | ProviderAdapterRequestError
  | ProviderAdapterProcessError;

export type ProviderServiceError =
  | ProviderValidationError
  | ProviderUnsupportedError
  | ProviderInstanceNotFoundError
  | ProviderSessionNotFoundError
  | ProviderSessionDirectoryPersistenceError
  | ProviderAdapterError
  | CheckpointServiceError;
