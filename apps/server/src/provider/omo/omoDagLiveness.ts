import { RuntimeTaskId, type ThreadDagRun } from "@t3tools/contracts";

// Terminal run statuses mirror omo's dag engine (TERMINAL_RUN_STATUSES in
// packages/omo-senpi/src/components/task/dag-runtime.ts). Anything outside
// this set counts as live — fail-open, so a future status vocabulary word
// reads as working instead of silently dropping the liveness signal.
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export type OmoDagRunTaskCompletedStatus = "completed" | "failed" | "stopped";

export interface OmoDagLivenessTransition {
  readonly started: ReadonlyArray<{ readonly runId: string; readonly name: string }>;
  readonly completed: ReadonlyArray<{
    readonly runId: string;
    readonly status: OmoDagRunTaskCompletedStatus;
  }>;
  readonly liveRuns: ReadonlyMap<string, string>;
}

export const omoDagRunLivenessTaskId = (runId: string): RuntimeTaskId =>
  RuntimeTaskId.make(`dag-run:${runId}`);

const toCompletedStatus = (status: string | undefined): OmoDagRunTaskCompletedStatus => {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
};

// Pure diff against the previous live-run set: wholesale snapshots replace
// state, so a run that vanished without a terminal row (truncated snapshot)
// still completes — liveness must never pin Working on a run we no longer see.
export const diffOmoDagRunLiveness = (
  previousLiveRuns: ReadonlyMap<string, string>,
  runs: readonly ThreadDagRun[],
): OmoDagLivenessTransition => {
  const liveRuns = new Map<string, string>();
  for (const run of runs) {
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      liveRuns.set(run.runId, run.name);
    }
  }
  const started = [...liveRuns]
    .filter(([runId]) => !previousLiveRuns.has(runId))
    .map(([runId, name]) => ({ runId, name }));
  const completed = [...previousLiveRuns.keys()]
    .filter((runId) => !liveRuns.has(runId))
    .map((runId) => {
      const terminalRun = runs.find(
        (run) => run.runId === runId && TERMINAL_RUN_STATUSES.has(run.status),
      );
      return { runId, status: toCompletedStatus(terminalRun?.status) };
    });
  return { started, completed, liveRuns };
};
