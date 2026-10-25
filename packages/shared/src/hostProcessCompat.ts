// Port shim (omo fork): omo-desktop imported host-process context from
// `@t3tools/shared/hostProcess`; v0.1.2 ships the same primitives as
// HostProcess.ts (Context.References). Re-export under the legacy names so
// the ported omo files keep their original import specifiers.
export {
  Architecture as HostProcessArchitecture,
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "./HostProcess.ts";
