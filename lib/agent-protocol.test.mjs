import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { verifyInstalledAgentProtocol } from "../scripts/verify-agent-protocol.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  assertPiAgentProtocol,
  PI_WEB_AGENT_PROTOCOL_VERSION,
} = await jiti.import("./agent-protocol.ts");

test("accepts only protocol v3 with pending-terminal ScheduleStore capability", () => {
  class CompatibleScheduleStore {
    markPendingTerminal() {}
  }
  const compatible = {
    PI_WEB_AGENT_PROTOCOL_VERSION,
    ScheduleStore: CompatibleScheduleStore,
    SCHEDULE_STORE_STATES: ["scheduled", "claimed", "running", "pending-terminal", "paused"],
    authorizePeerSessionRuntime() {},
    verifyStoredSessionTarget() {},
  };
  assert.equal(PI_WEB_AGENT_PROTOCOL_VERSION, 3);
  assert.doesNotThrow(() => assertPiAgentProtocol(compatible));
  assert.equal(verifyInstalledAgentProtocol(compatible), 3);

  class LegacyV2ScheduleStore {}
  const legacyV2 = {
    PI_WEB_AGENT_PROTOCOL_VERSION: 2,
    ScheduleStore: LegacyV2ScheduleStore,
    authorizePeerSessionRuntime() {},
    verifyStoredSessionTarget() {},
  };
  assert.throws(() => assertPiAgentProtocol(legacyV2), /expected 3, got 2/i);
  assert.throws(() => verifyInstalledAgentProtocol(legacyV2), /expected 3, got 2/i);

  class MissingPendingMethodScheduleStore {}
  assert.throws(
    () => assertPiAgentProtocol({ ...compatible, ScheduleStore: MissingPendingMethodScheduleStore }),
    /markPendingTerminal/,
  );
  assert.throws(
    () => verifyInstalledAgentProtocol({ ...compatible, ScheduleStore: MissingPendingMethodScheduleStore }),
    /markPendingTerminal/,
  );
  assert.throws(
    () => assertPiAgentProtocol({ ...compatible, SCHEDULE_STORE_STATES: ["scheduled", "claimed", "running", "paused"] }),
    /pending-terminal/,
  );
  assert.throws(
    () => verifyInstalledAgentProtocol({ ...compatible, SCHEDULE_STORE_STATES: ["scheduled", "claimed", "running", "paused"] }),
    /pending-terminal/,
  );
});
