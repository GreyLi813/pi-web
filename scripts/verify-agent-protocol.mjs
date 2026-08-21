import { pathToFileURL } from "node:url";
import * as PiAgent from "@earendil-works/pi-coding-agent";

const EXPECTED_PROTOCOL_VERSION = 3;
const REQUIRED_APIS = [
  "ScheduleStore",
  "ScheduleStore.markPendingTerminal",
  "authorizePeerSessionRuntime",
  "verifyStoredSessionTarget",
];
const REQUIRED_SCHEDULE_STATES = ["pending-terminal"];

/** Verify the installed package before build/start instead of failing on a late import.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function verifyInstalledAgentProtocol(surface = PiAgent) {
  if (surface.PI_WEB_AGENT_PROTOCOL_VERSION !== EXPECTED_PROTOCOL_VERSION) {
    throw new Error(
      `Incompatible Pi Agent protocol: expected ${EXPECTED_PROTOCOL_VERSION}, got ${String(surface.PI_WEB_AGENT_PROTOCOL_VERSION)}. `
      + "Install the published protocol-compatible package or a tarball produced by pack-pi-agent-protocol.mjs.",
    );
  }
  for (const api of REQUIRED_APIS) {
    const candidate = api === "ScheduleStore.markPendingTerminal"
      ? surface.ScheduleStore?.prototype?.markPendingTerminal
      : surface[api];
    if (typeof candidate !== "function") throw new Error(`Pi Agent protocol is missing required API '${api}'`);
  }
  for (const state of REQUIRED_SCHEDULE_STATES) {
    if (!Array.isArray(surface.SCHEDULE_STORE_STATES) || !surface.SCHEDULE_STORE_STATES.includes(state)) {
      throw new Error(`Pi Agent protocol is missing required Schedule state '${state}'`);
    }
  }
  return EXPECTED_PROTOCOL_VERSION;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`Pi Agent protocol v${verifyInstalledAgentProtocol()} is compatible.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
