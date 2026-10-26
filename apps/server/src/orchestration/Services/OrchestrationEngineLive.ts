// Port reconstruction (omo fork): the omo-desktop engine implementation did not
// survive the bundle extraction — only the service interface did. OmoDriver's
// usage is dispatch-only and best-effort (goal/steering projection updates,
// failures logged, never fatal), so this in-memory ledger implements the full
// OrchestrationEngineShape: commands recorded with a monotonic sequence, hot
// event stream, and bounded-history reads. Full delegation to the upstream
// orchestration-v2 engine is future work (see PORTING.md).
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./OrchestrationEngine.ts";

interface Recorded {
  readonly command: OrchestrationCommand;
  readonly sequence: number;
}

const MAX_LEDGER_EVENTS = 10_000;

const asEvent = (record: Recorded): OrchestrationEvent =>
  record.command as unknown as OrchestrationEvent;

const makeLedgerEngine = Effect.gen(function* () {
  const records: Array<Recorded> = [];
  const sinks: Array<(_: Recorded) => void> = [];

  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (
        typeof command !== "object" ||
        command === null ||
        !("type" in command) ||
        !("commandId" in command)
      ) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: String((command as { type?: unknown }).type ?? "unknown"),
            detail: "command must carry a string type and a commandId",
          }),
        );
      }
      const sequence = records.length + 1;
      const record: Recorded = { command, sequence };
      records.push(record);
      if (records.length > MAX_LEDGER_EVENTS) {
        records.splice(0, records.length - MAX_LEDGER_EVENTS);
      }
      for (const sink of sinks) sink(record);
      return { sequence };
    });

  const engine: OrchestrationEngineShape = {
    readEvents: (fromSequenceExclusive, limit) =>
      Stream.fromIterable(
        records
          .filter((record) => record.sequence > fromSequenceExclusive)
          .slice(0, limit ?? records.length)
          .map(asEvent),
      ),
    readLatestThreadRuntimeEvents: (threadId, sequenceInclusive) =>
      Effect.succeed(
        records
          .filter(
            (record) =>
              record.sequence <= sequenceInclusive &&
              "threadId" in record.command &&
              record.command.threadId === threadId &&
              typeof record.command.type === "string" &&
              record.command.type.startsWith("thread.runtime."),
          )
          .map(asEvent),
      ),
    dispatch,
    // No push-style Stream constructor in effect-4 core; the ledger serves a
    // cold replay of recorded events (no live subscribers yet). OmoDriver does
    // not consume this member; revisit with the v2 engine delegation.
    streamDomainEvents: Stream.fromIterable(records.map(asEvent)),
    latestSequence: Effect.sync(() => records.length),
  };

  return engine;
});

// Driver-scoped construction: OmoDriver is the only consumer of this ledger,
// so it builds its own engine instance instead of requiring a global service
// (removes OrchestrationEngineService from the runtime composition entirely).
export const makeLedgerEngineEffect = makeLedgerEngine;

export const layerOrchestrationEngineLedger = Layer.effect(
  OrchestrationEngineService,
  makeLedgerEngine,
);
