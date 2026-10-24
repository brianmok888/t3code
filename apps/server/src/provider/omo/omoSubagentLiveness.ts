import { RuntimeTaskId, type ThreadSubagentTask } from "@t3tools/contracts";

export type OmoSubagentTaskCompletedStatus = "completed" | "failed" | "stopped";

export interface OmoSubagentLivenessTransition {
  readonly started: ReadonlyArray<{ readonly taskId: string; readonly description: string }>;
  readonly completed: ReadonlyArray<{
    readonly taskId: string;
    readonly status: OmoSubagentTaskCompletedStatus;
  }>;
  readonly liveTasks: ReadonlyMap<string, string>;
}

export const omoSubagentLivenessTaskId = (taskId: string): RuntimeTaskId =>
  RuntimeTaskId.make(`omo-task:${taskId}`);

// A child counts as live only while its record says it can still act: an
// unsettled status AND resident residency. Suspended residencies
// (persisted_only, rpc_detached, evicted, disposed) mirror the subagent
// panel's "suspended" classification and must not pin the thread Working;
// omo re-emits a wholesale omo.task.updated snapshot on session (re)attach,
// which re-latches liveness for children that really survived a restart.
const isLiveSubagent = (task: ThreadSubagentTask): boolean =>
  (task.status === "pending" || task.status === "running") && task.residencyState === "resident";

const toCompletedStatus = (
  status: ThreadSubagentTask["status"] | undefined,
): OmoSubagentTaskCompletedStatus => {
  if (status === "completed") return "completed";
  if (status === "error") return "failed";
  return "stopped";
};

// Pure diff against the previous live-task set: snapshots are wholesale, so a
// task that vanished (or fell out of residency) without a terminal status
// still completes — liveness must never pin Working on a child we no longer
// see acting.
export const diffOmoSubagentLiveness = (
  previousLiveTasks: ReadonlyMap<string, string>,
  tasks: readonly ThreadSubagentTask[],
): OmoSubagentLivenessTransition => {
  const liveTasks = new Map<string, string>();
  for (const task of tasks) {
    if (isLiveSubagent(task)) {
      liveTasks.set(task.taskId, task.taskSummary ?? task.name ?? task.description ?? task.taskId);
    }
  }
  const started = [...liveTasks]
    .filter(([taskId]) => !previousLiveTasks.has(taskId))
    .map(([taskId, description]) => ({ taskId, description }));
  const completed = [...previousLiveTasks.keys()]
    .filter((taskId) => !liveTasks.has(taskId))
    .map((taskId) => {
      const terminalTask = tasks.find((task) => task.taskId === taskId && !isLiveSubagent(task));
      return { taskId, status: toCompletedStatus(terminalTask?.status) };
    });
  return { started, completed, liveTasks };
};
