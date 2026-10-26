// DEPRECATED (omo fork): superseded by the CORE `effect/process` module —
// omo-era process API (sync ChildProcess.make array-form, callable handle.kill,
// cwd/env/shell/killSignal/forceKillAfter options) matches effect-4 core
// natively, and the ChildProcessSpawner service is provided by
// @effect/platform-node NodeServices.layer. Kept only as a pointer; do not
// import from new code.
export { ChildProcess, ChildProcessSpawner } from "effect/process";
export type { Command, StandardCommand } from "effect/process/ChildProcess";
export type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
