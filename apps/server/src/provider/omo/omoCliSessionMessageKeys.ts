/**
 * Stable message keys for every CLI-session adoption refusal.
 *
 * An error's `message` is evidence for a log, not copy for a user: it names
 * absolute paths, digests and line numbers. The web UI needs the opposite — a
 * key it can look a sentence up by, that survives rewording the sentence and
 * never changes when a path changes. That key is what this module owns.
 *
 * The keys are DATA, not derived from the tag at runtime: a mechanical
 * `_tag`-to-key transform would silently rename every UI string the day an
 * error is renamed. Corruption is keyed per DEFECT because "line 12 is
 * unparseable" and "two entries share an id" are different things to tell a
 * user, and an unsupported version is keyed to the action the user can take
 * (update the app) rather than to the condition.
 *
 * @module provider/omo/omoCliSessionMessageKeys
 */
import type { CliSessionDefect, OmoCliSessionError } from "./omoCliSessionErrors.ts";

/**
 * Every key the adoption surface can emit. Exported so the UI catalog and the
 * uniqueness test read the same list this module dispatches on.
 */
export const CLI_SESSION_MESSAGE_KEYS = {
  notFound: "cliSession.adopt.notFound",
  idMismatch: "cliSession.adopt.idMismatch",
  alreadyAdopted: "cliSession.adopt.alreadyAdopted",
  cwdMismatch: "cliSession.adopt.cwdMismatch",
  tooLarge: "cliSession.adopt.tooLarge",
  duplicateConflict: "cliSession.adopt.duplicateConflict",
  versionUnsupported: "cliSession.adopt.versionUnsupported.updateApp",
  corruptMissingHeader: "cliSession.adopt.corrupt.missingHeader",
  corruptMalformedInteriorLine: "cliSession.adopt.corrupt.malformedInteriorLine",
  corruptDuplicateEntryId: "cliSession.adopt.corrupt.duplicateEntryId",
  corruptUnknownParentId: "cliSession.adopt.corrupt.unknownParentId",
  corruptParentCycle: "cliSession.adopt.corrupt.parentCycle",
  corruptUnsupportedVersion: "cliSession.adopt.corrupt.unsupportedVersion",
} as const;

export type CliSessionMessageKey =
  (typeof CLI_SESSION_MESSAGE_KEYS)[keyof typeof CLI_SESSION_MESSAGE_KEYS];

const CORRUPT_KEYS: Record<CliSessionDefect, CliSessionMessageKey> = {
  missing_header: CLI_SESSION_MESSAGE_KEYS.corruptMissingHeader,
  malformed_interior_line: CLI_SESSION_MESSAGE_KEYS.corruptMalformedInteriorLine,
  duplicate_entry_id: CLI_SESSION_MESSAGE_KEYS.corruptDuplicateEntryId,
  unknown_parent_id: CLI_SESSION_MESSAGE_KEYS.corruptUnknownParentId,
  parent_cycle: CLI_SESSION_MESSAGE_KEYS.corruptParentCycle,
  unsupported_version: CLI_SESSION_MESSAGE_KEYS.corruptUnsupportedVersion,
};

/**
 * The stable key for one refusal, for a UI that renders a sentence and an
 * action from it. The error keeps carrying its own evidence; this only decides
 * WHICH sentence.
 */
export const cliSessionMessageKey = (error: OmoCliSessionError): CliSessionMessageKey => {
  switch (error._tag) {
    case "SessionNotFound":
      return CLI_SESSION_MESSAGE_KEYS.notFound;
    case "SessionCorrupt":
      return CORRUPT_KEYS[error.defect];
    case "SessionIdMismatch":
      return CLI_SESSION_MESSAGE_KEYS.idMismatch;
    case "SessionAlreadyAdopted":
      return CLI_SESSION_MESSAGE_KEYS.alreadyAdopted;
    case "SessionVersionUnsupported":
      return CLI_SESSION_MESSAGE_KEYS.versionUnsupported;
    case "SessionTooLarge":
      return CLI_SESSION_MESSAGE_KEYS.tooLarge;
    case "SessionDuplicateConflict":
      return CLI_SESSION_MESSAGE_KEYS.duplicateConflict;
    case "CwdMismatch":
      return CLI_SESSION_MESSAGE_KEYS.cwdMismatch;
  }
};
