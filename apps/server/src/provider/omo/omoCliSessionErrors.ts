/**
 * Error taxonomy for adopting a session created by the omo native CLI.
 *
 * Adoption reads a file the user's CLI owns, so every refusal has to name a
 * cause the UI can act on: a path that vanished, a file a newer engine wrote,
 * a file already bound to a thread, or a defect that makes the on-disk tree
 * ambiguous. Each error carries the evidence that produced it (line number,
 * ids, sizes) rather than a rendered sentence, so the same failure can be
 * reported, logged and tested without re-deriving the facts.
 *
 * @module provider/omo/omoCliSessionErrors
 */
import * as Schema from "effect/Schema";

/**
 * Structural defects that make a session file non-adoptable.
 *
 * A torn FINAL line is deliberately absent: an append-only writer killed
 * mid-write leaves exactly that, and discarding the partial line loses nothing
 * that was ever committed. Every kind here means the tree itself cannot be
 * trusted.
 */
export const CliSessionDefect = Schema.Literals([
  "missing_header",
  "malformed_interior_line",
  "duplicate_entry_id",
  "unknown_parent_id",
  "parent_cycle",
  "unsupported_version",
]);
export type CliSessionDefect = typeof CliSessionDefect.Type;

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionPath: Schema.String,
}) {
  override get message(): string {
    return `No omo CLI session file at ${this.sessionPath}`;
  }
}

/**
 * The file exists but its entry tree cannot be trusted. `line` is the 1-based
 * physical line that produced the defect, or null when the defect is a property
 * of the whole file (a missing header, an unsupported version).
 */
export class SessionCorrupt extends Schema.TaggedErrorClass<SessionCorrupt>()("SessionCorrupt", {
  sessionPath: Schema.String,
  defect: CliSessionDefect,
  line: Schema.NullOr(Schema.Number),
}) {
  override get message(): string {
    const where = this.line === null ? "" : ` at line ${this.line}`;
    return `omo CLI session ${this.sessionPath} is corrupt (${this.defect})${where}`;
  }
}

/**
 * The header id does not match the id the caller expected. Session files are
 * addressed by path, and a path can be reused, so the id read from the header
 * is the only identity that survives a rename.
 */
export class SessionIdMismatch extends Schema.TaggedErrorClass<SessionIdMismatch>()(
  "SessionIdMismatch",
  {
    sessionPath: Schema.String,
    expectedSessionId: Schema.String,
    foundSessionId: Schema.String,
  },
) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} holds session ${this.foundSessionId}, expected ${this.expectedSessionId}`;
  }
}

/** The session is already bound to a thread; adopting again would fork history. */
export class SessionAlreadyAdopted extends Schema.TaggedErrorClass<SessionAlreadyAdopted>()(
  "SessionAlreadyAdopted",
  {
    sessionPath: Schema.String,
    existingThreadId: Schema.String,
  },
) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} is already adopted by thread ${this.existingThreadId}`;
  }
}

/**
 * The header declares a version this build cannot read. Reading it anyway would
 * mean guessing at a schema a newer engine defined; migrating it would mean
 * rewriting a file the user's CLI still owns.
 */
export class SessionVersionUnsupported extends Schema.TaggedErrorClass<SessionVersionUnsupported>()(
  "SessionVersionUnsupported",
  {
    sessionPath: Schema.String,
    version: Schema.Number,
    supportedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} is version ${this.version}; this build reads up to version ${this.supportedVersion}`;
  }
}

/** The file is past the read ceiling, so inspection would be unbounded work. */
export class SessionTooLarge extends Schema.TaggedErrorClass<SessionTooLarge>()("SessionTooLarge", {
  sessionPath: Schema.String,
  byteSize: Schema.Number,
  maxByteSize: Schema.Number,
}) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} is ${this.byteSize} bytes, over the ${this.maxByteSize}-byte adoption ceiling`;
  }
}

/**
 * Two files on disk claim the same header id with DIFFERENT content, so which
 * one the id names cannot be decided. Adoption of EITHER is blocked: picking
 * the newer or the alphabetically first would be a guess, and the losing file
 * is somebody's conversation.
 *
 * Identical content is not this error — that is an alias, and adopting one copy
 * of two identical files loses nothing.
 */
export class SessionDuplicateConflict extends Schema.TaggedErrorClass<SessionDuplicateConflict>()(
  "SessionDuplicateConflict",
  {
    sessionPath: Schema.String,
    conflictingSessionPath: Schema.String,
    sessionId: Schema.String,
  },
) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} and ${this.conflictingSessionPath} both claim session ${this.sessionId} with different content`;
  }
}

/**
 * The session's recorded cwd is not the workspace being adopted into. The
 * directory-name prefilter is lossy, so this is the check that actually decides
 * whether a candidate file belongs to a workspace.
 */
export class CwdMismatch extends Schema.TaggedErrorClass<CwdMismatch>()("CwdMismatch", {
  sessionPath: Schema.String,
  sessionCwd: Schema.String,
  workspaceRoot: Schema.String,
}) {
  override get message(): string {
    return `omo CLI session ${this.sessionPath} was recorded in ${this.sessionCwd}, not ${this.workspaceRoot}`;
  }
}

/** Every refusal reason adoption can produce. */
export type OmoCliSessionError =
  | SessionNotFound
  | SessionCorrupt
  | SessionIdMismatch
  | SessionAlreadyAdopted
  | SessionVersionUnsupported
  | SessionTooLarge
  | SessionDuplicateConflict
  | CwdMismatch;
