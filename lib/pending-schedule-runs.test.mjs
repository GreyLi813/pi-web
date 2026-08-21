import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { PendingScheduleRunRegistry } = await jiti.import("./pending-schedule-runs.ts");

function identity(overrides = {}) {
  return {
    storePath: "D:/agent/schedules.json",
    scheduleId: "schedule-a",
    runId: "run-a",
    ownerId: "owner-a",
    ...overrides,
  };
}

test("registry is bounded and rejects a duplicate reservation for the same exact run", async () => {
  const registry = new PendingScheduleRunRegistry(1);
  const first = registry.reserve(identity());
  assert.equal(first.status, "reserved");
  assert.deepEqual(registry.reserve(identity()), { status: "duplicate" });
  assert.deepEqual(registry.reserve(identity({ scheduleId: "schedule-b", runId: "run-b" })), { status: "full" });
  await registry.shutdown();
});

test("a rejected terminal is observed as failure without an unhandled rejection", async () => {
  const registry = new PendingScheduleRunRegistry(1);
  const reserved = registry.reserve(identity());
  if (reserved.status !== "reserved") throw new Error("Test reservation failed");
  let heartbeatStops = 0;
  registry.setHeartbeat(reserved.reservation, {
    async stop() { heartbeatStops++; },
  });
  let rejectTerminal;
  const terminal = new Promise((_resolve, reject) => { rejectTerminal = reject; });
  let cancelRequests = 0;
  registry.attachObserver(reserved.reservation, {
    runId: "run-a",
    runEpoch: 4,
    terminal,
    async requestCancel() { cancelRequests++; },
  });
  assert.equal(await registry.requestCancel(identity({ runId: "other-run" })), false);
  assert.equal(await registry.requestCancel(identity()), true);
  assert.equal(cancelRequests, 1);
  let observed;
  const completed = new Promise((resolve) => {
    registry.monitorTerminal(reserved.reservation, async (outcome) => {
      observed = outcome;
      resolve();
    });
  });
  rejectTerminal(new Error("late provider rejection"));
  await completed;
  const deadline = Date.now() + 1_000;
  while (registry.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(observed?.status, "failed");
  assert.match(String(observed?.error), /late provider rejection/);
  assert.equal(registry.size, 0);
  assert.equal(heartbeatStops, 1);
});

test("shutdown detaches an unresolved observer and stops its heartbeat", async () => {
  const registry = new PendingScheduleRunRegistry(1);
  const reserved = registry.reserve(identity());
  if (reserved.status !== "reserved") throw new Error("Test reservation failed");
  let heartbeatStops = 0;
  registry.setHeartbeat(reserved.reservation, {
    async stop() { heartbeatStops++; },
  });
  registry.attachObserver(reserved.reservation, {
    runId: "run-a",
    runEpoch: 5,
    terminal: new Promise(() => undefined),
    async requestCancel() {},
  });
  registry.monitorTerminal(reserved.reservation, async () => {
    throw new Error("An unresolved terminal must not complete");
  });

  await registry.shutdown();
  assert.equal(registry.size, 0);
  assert.equal(heartbeatStops, 1);
  assert.deepEqual(registry.reserve(identity({ runId: "after-stop" })), { status: "full" });
});
