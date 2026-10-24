// @effect-diagnostics nodeBuiltinImport:off
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Desktop attribution for the bundled omo runtime's telemetry (schema v3).
 * The runtime reads `OMO_NATIVE_SURFACE` / `OMO_NATIVE_INSTALL_ID` from its
 * env (oh-my-openagent `product-identity.ts`) and stamps both on every event.
 * The install id is the SAME `<agent-home>/omo-senpi/omo-native/install-id`
 * file the runtime owns, so CLI and Desktop converge on one id per machine
 * without deriving anything from the machine itself; a remote (SSH/WSL)
 * runtime pinned to this host's agent dir reports the local installation's id.
 */

export const OMO_NATIVE_SURFACE_ENV = "OMO_NATIVE_SURFACE";
export const OMO_NATIVE_INSTALL_ID_ENV = "OMO_NATIVE_INSTALL_ID";

const INSTALL_ID_FILE_NAME = "install-id";
const INSTALL_ID_PATTERN = /^[0-9a-f]{64}$/;
const fallbackInstallIds = new Map<string, string>();

function installIdPath(codingAgentDir: string): string {
  return join(codingAgentDir, "omo-senpi", "omo-native", INSTALL_ID_FILE_NAME);
}

function readInstallId(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return INSTALL_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Read-or-create the shared install id. Never throws: concurrent creates are
 * absorbed and an unwritable location falls back to one in-memory id per path,
 * so attribution degrades to "no id" rather than breaking the spawn. */
export function readOrCreateOmoInstallId(codingAgentDir: string): string | undefined {
  const path = installIdPath(codingAgentDir);
  const persisted = readInstallId(path);
  if (persisted !== undefined) {
    fallbackInstallIds.delete(path);
    return persisted;
  }

  const installId = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${installId}\n`, { flag: "wx", mode: 0o600 });
    fallbackInstallIds.delete(path);
    return installId;
  } catch {
    if (existsSync(path)) {
      const concurrentlyCreated = readInstallId(path);
      if (concurrentlyCreated !== undefined) {
        fallbackInstallIds.delete(path);
        return concurrentlyCreated;
      }
    }
    try {
      writeFileSync(path, `${installId}\n`, { flag: "w", mode: 0o600 });
      fallbackInstallIds.delete(path);
      return installId;
    } catch {
      return fallbackInstallIds.get(path) ?? (fallbackInstallIds.set(path, installId), installId);
    }
  }
}

/** Env slice for every omo child spawn: `surface` is always set (a
 * Desktop-driven turn is Desktop usage, never CLI adoption); the id rides
 * along whenever the shared file is reachable. */
export function buildOmoTelemetrySpawnEnv(codingAgentDir: string): Record<string, string> {
  const installId = readOrCreateOmoInstallId(codingAgentDir);
  return {
    [OMO_NATIVE_SURFACE_ENV]: "desktop",
    ...(installId === undefined ? {} : { [OMO_NATIVE_INSTALL_ID_ENV]: installId }),
  };
}
