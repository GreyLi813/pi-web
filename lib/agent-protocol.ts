export const PI_WEB_AGENT_PROTOCOL_VERSION = 3;

const REQUIRED_APIS = [
  "ScheduleStore",
  "ScheduleStore.markPendingTerminal",
  "authorizePeerSessionRuntime",
  "verifyStoredSessionTarget",
] as const;
const REQUIRED_SCHEDULE_STATES = ["pending-terminal"] as const;

interface AgentProtocolSurface {
  PI_WEB_AGENT_PROTOCOL_VERSION?: unknown;
  ScheduleStore?: unknown;
  SCHEDULE_STORE_STATES?: unknown;
  authorizePeerSessionRuntime?: unknown;
  verifyStoredSessionTarget?: unknown;
}

/** Fail fast when Pi-Web is paired with an unpublished/incompatible Agent package.
 *
 * This guards clean installs that still resolve the public 0.83.0 package,
 * which does not contain the peer/scheduler authority APIs implemented in the
 * adjacent pi-agent worktree.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertPiAgentProtocol(surface: AgentProtocolSurface): void {
  if (surface.PI_WEB_AGENT_PROTOCOL_VERSION !== PI_WEB_AGENT_PROTOCOL_VERSION) {
    throw new Error(
      `Incompatible Pi Agent protocol: expected ${PI_WEB_AGENT_PROTOCOL_VERSION}, got ${String(surface.PI_WEB_AGENT_PROTOCOL_VERSION)}. `
      + "Install the release tarball produced by scripts/pack-pi-agent-protocol.mjs.",
    );
  }
  const scheduleStore = surface.ScheduleStore as { prototype?: { markPendingTerminal?: unknown } };
  for (const api of REQUIRED_APIS) {
    const candidate = api === "ScheduleStore.markPendingTerminal"
      ? scheduleStore.prototype?.markPendingTerminal
      : surface[api];
    if (typeof candidate !== "function") {
      throw new Error(`Compatible Pi Agent protocol is missing required API '${api}'`);
    }
  }
  for (const state of REQUIRED_SCHEDULE_STATES) {
    if (!Array.isArray(surface.SCHEDULE_STORE_STATES) || !surface.SCHEDULE_STORE_STATES.includes(state)) {
      throw new Error(`Compatible Pi Agent protocol is missing required Schedule state '${state}'`);
    }
  }
}
