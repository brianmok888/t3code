import * as Schema from "effect/Schema";

export const OmoRuntimeModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
});
export type OmoRuntimeModel = typeof OmoRuntimeModel.Type;

export const OmoRuntimeSessionState = Schema.Struct({
  model: Schema.optionalKey(Schema.NullOr(OmoRuntimeModel)),
});
export type OmoRuntimeSessionState = typeof OmoRuntimeSessionState.Type;

export const OmoOpenSessionData = Schema.Struct({
  /** Epoch-local routing handle. Never persist this value. */
  sessionId: Schema.String,
  /** Durable session state. Its `sessionId` belongs in the resume cursor. */
  state: OmoRuntimeSessionState,
});
export type OmoOpenSessionData = typeof OmoOpenSessionData.Type;
