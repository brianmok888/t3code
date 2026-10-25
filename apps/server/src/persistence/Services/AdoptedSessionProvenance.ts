// Port reconstruction (omo fork): omo-desktop's adopted-session provenance
// repository did not survive the bundle extraction, so it is rebuilt here
// against the single surface the ported session catalog consumes:
// findBySourcePath. Store is a lazily-read JSON file so the CLI-session
// catalog can dedupe against previously adopted sessions without a DB.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class AdoptedSessionProvenanceRepositoryError extends Data.TaggedError(
  "AdoptedSessionProvenanceRepositoryError",
)<{ readonly reason: string; readonly cause?: unknown }> {}

const AdoptedRecord = Schema.Struct({
  threadId: Schema.String,
  sourcePath: Schema.String,
  adoptedAt: Schema.String,
});
type AdoptedRecord = typeof AdoptedRecord.Type;

const StoreFile = Schema.Struct({
  records: Schema.Array(AdoptedRecord),
});
type StoreFile = typeof StoreFile.Type;

const EMPTY: StoreFile = { records: [] };

const storePath = (): string => {
  const override = process.env.T3_ADOPTED_PROVENANCE_PATH;
  if (override && override.length > 0) return override;
  const home = process.env.HOME ?? process.cwd();
  return `${home}/.t3code/adopted-sessions.json`;
};

export interface AdoptedSessionProvenanceService {
  readonly findBySourcePath: (input: {
    readonly sourcePath: string;
  }) => Effect.Effect<Option.Option<AdoptedRecord>, AdoptedSessionProvenanceRepositoryError>;
  readonly markAdopted: (input: {
    readonly sourcePath: string;
    readonly threadId: string;
  }) => Effect.Effect<void, AdoptedSessionProvenanceRepositoryError>;
  readonly listAdopted: () => Effect.Effect<
    ReadonlyArray<AdoptedRecord>,
    AdoptedSessionProvenanceRepositoryError
  >;
}

export class AdoptedSessionProvenanceRepository extends Context.Service<
  AdoptedSessionProvenanceRepository,
  AdoptedSessionProvenanceService
>("omo/persistence/AdoptedSessionProvenanceRepository") {}

export const AdoptedSessionProvenanceRepositoryLive = Layer.effect(
  AdoptedSessionProvenanceRepository,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const readStore = (): Effect.Effect<StoreFile, AdoptedSessionProvenanceRepositoryError> =>
      fs.readFile(storePath()).pipe(
        Effect.map((bytes) => {
          try {
            const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
            const decoded = Schema.decodeUnknownSync(StoreFile)(parsed);
            return decoded;
          } catch {
            return EMPTY;
          }
        }),
        Effect.orElseSucceed(() => EMPTY),
        Effect.mapError(
          (cause) =>
            new AdoptedSessionProvenanceRepositoryError({
              reason: "failed to read provenance store",
              cause,
            }),
        ),
      );

    const writeStore = (
      store: StoreFile,
    ): Effect.Effect<void, AdoptedSessionProvenanceRepositoryError> =>
      fs.writeFile(storePath(), new TextEncoder().encode(JSON.stringify(store, null, 2))).pipe(
        Effect.mapError(
          (cause) =>
            new AdoptedSessionProvenanceRepositoryError({
              reason: "failed to write provenance store",
              cause,
            }),
        ),
      );

    return {
      findBySourcePath: (input) =>
        readStore().pipe(
          Effect.map((store) =>
            ((): Option.Option<AdoptedRecord> => {
              const hit = store.records.find((record) => record.sourcePath === input.sourcePath);
              return hit === undefined ? Option.none() : Option.some(hit);
            })(),
          ),
        ),
      markAdopted: (input) =>
        readStore().pipe(
          Effect.flatMap((store) => {
            const next: StoreFile = {
              records: [
                ...store.records.filter((record) => record.sourcePath !== input.sourcePath),
                {
                  sourcePath: input.sourcePath,
                  threadId: input.threadId,
                  adoptedAt: new Date().toISOString(),
                },
              ],
            };
            return writeStore(next);
          }),
        ),
      listAdopted: () => readStore().pipe(Effect.map((store) => store.records)),
    };
  }),
);
