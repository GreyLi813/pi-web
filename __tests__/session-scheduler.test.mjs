import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  ScheduleStore,
  SessionManager,
  verifySessionTarget,
} = await jiti.import("@earendil-works/pi-coding-agent");
const {
  PersistentSessionScheduler,
  runSchedulePass,
} = await jiti.import("../lib/session-scheduler.ts");
const { dispatchScheduleToAgent } = await jiti.import("../lib/schedule-dispatch.ts");
const { PendingScheduleRunRegistry } = await jiti.import("../lib/pending-schedule-runs.ts");

/** Build one isolated exact target and strict ScheduleStore.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-scheduler-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const manager = SessionManager.create(root, sessionDir);
  manager.appendSessionInfo("Schedule target");
  const sessionFile = manager.persistSession();
  if (!sessionFile) throw new Error("Test Session did not persist");
  const target = await verifySessionTarget({
    sessionId: manager.getSessionId(),
    sessionFile,
    sessionDir,
    cwd: root,
    rejectOrchestration: true,
  });
  return { root, agentDir, target, store: new ScheduleStore(agentDir) };
}

/** Build a fake agent that returns matching terminal run identity.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function successfulAgent(commands, fail = false, target) {
  return {
    sessionFile: target?.sessionFile,
    sessionFileKey: target?.fileKey,
    isRunning: () => false,
    isOrchestratedWorker: () => false,
    async send(command) {
      commands.push(command);
      if (command.type === "get_state") return { runEpoch: 3 };
      if (fail) throw new Error("first provider failed");
      return {
        runId: command.runId,
        runEpoch: command.runEpoch,
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    },
  };
}

/** Wait for one asynchronously started lifecycle pass to persist its outcome.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function waitForSchedule(store, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const schedule = (await store.read()).schedules[0];
    if (schedule && predicate(schedule)) return schedule;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Scheduler lifecycle pass did not finish");
}

test("one failed schedule does not block the next claimed schedule", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = Date.now();
  await fixture.store.createMany([
    { target: fixture.target, intervalSeconds: 60, prompt: "first", policy: { version: 1, toolNames: [], thinkingLevel: "off" }, nextFireAt: now },
    { target: fixture.target, intervalSeconds: 60, prompt: "second", policy: { version: 1, toolNames: [], thinkingLevel: "off" }, nextFireAt: now },
  ]);
  const commands = [];
  const dependencies = {
    getSession: () => undefined,
    startSession: async (schedule) => successfulAgent(commands, schedule.prompt === "first", schedule.target),
    now: () => now + 10,
  };

  const result = await runSchedulePass(fixture.store, "leader", dependencies, 2);
  const data = await fixture.store.read();
  assert.deepEqual(result, { claimed: 2, succeeded: 1, failed: 1, deferred: 0 });
  assert.equal(data.schedules.find((entry) => entry.prompt === "first")?.failureCount, 1);
  assert.equal(data.schedules.find((entry) => entry.prompt === "second")?.fireCount, 1);
});

test("service start dispatches due work without a browser ticker", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = Date.now();
  await fixture.store.create({
    target: fixture.target,
    intervalSeconds: 60,
    prompt: "server lifecycle",
    policy: { version: 1, toolNames: [], thinkingLevel: "off" },
    nextFireAt: now,
  });
  const commands = [];
  const scheduler = new PersistentSessionScheduler(fixture.agentDir, {
    getSession: () => undefined,
    startSession: async (schedule) => successfulAgent(commands, false, schedule.target),
    now: () => now + 1,
  }, "test-leader");
  context.after(() => scheduler.stop());

  await scheduler.start();
  await scheduler.runNow();
  const completed = await waitForSchedule(fixture.store, (schedule) => schedule.fireCount === 1);
  assert.equal(completed.fireCount, 1);
  assert.equal(commands.some((command) => command.type === "scheduled_prompt"), true);
  await scheduler.stop();
});

test("service restart recovers an expired persistent claim", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = Date.now();
  await fixture.store.create({
    target: fixture.target,
    intervalSeconds: 60,
    prompt: "recover after restart",
    policy: { version: 1, toolNames: [], thinkingLevel: "off" },
    nextFireAt: now,
  });
  await fixture.store.claimDue({ ownerId: "dead-process", now, leaseMs: 1_000 });
  const commands = [];
  const scheduler = new PersistentSessionScheduler(fixture.agentDir, {
    getSession: () => undefined,
    startSession: async (schedule) => successfulAgent(commands, false, schedule.target),
    now: () => now + 2_000,
  }, "restarted-leader");
  context.after(() => scheduler.stop());

  await scheduler.start();
  await scheduler.runNow();
  const recovered = await waitForSchedule(fixture.store, (schedule) => schedule.fireCount === 1);
  assert.equal(recovered.fireCount, 1);
  assert.equal(recovered.failureCount, 1);
  assert.equal(recovered.claim, undefined);
  await scheduler.stop();
});

test("an unconfirmed cancel transfers to a live monitor without blocking other schedules", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let now = Date.now();
  const siblingManager = SessionManager.create(fixture.root, join(fixture.root, "sibling-sessions"));
  siblingManager.appendSessionInfo("Sibling Schedule target");
  const siblingFile = siblingManager.persistSession();
  if (!siblingFile) throw new Error("Sibling test Session did not persist");
  const siblingTarget = await verifySessionTarget({
    sessionId: siblingManager.getSessionId(),
    sessionFile: siblingFile,
    sessionDir: siblingManager.getSessionDir(),
    cwd: fixture.root,
    rejectOrchestration: true,
  });
  const pendingRuns = new PendingScheduleRunRegistry(2);
  context.after(() => pendingRuns.shutdown());
  const [pendingSchedule, siblingSchedule] = await fixture.store.createMany([
    {
      target: fixture.target,
      intervalSeconds: 60,
      prompt: "pending terminal",
      policy: { version: 1, toolNames: [], thinkingLevel: "off" },
      nextFireAt: now,
    },
    {
      target: siblingTarget,
      intervalSeconds: 60,
      prompt: "sibling",
      policy: { version: 1, toolNames: [], thinkingLevel: "off" },
      nextFireAt: now + 3_000,
    },
  ]);
  let resolveLateTerminal;
  const lateTerminal = new Promise((resolve) => { resolveLateTerminal = resolve; });
  const pendingAgent = {
    sessionFile: fixture.target.sessionFile,
    sessionFileKey: fixture.target.fileKey,
    isRunning: () => false,
    isOrchestratedWorker: () => false,
    async send(command) {
      if (command.type === "get_state") return { runEpoch: 10 };
      if (command.type === "cancel_run") return { cancelled: false };
      return lateTerminal;
    },
  };
  const dependencies = {
    getSession: () => undefined,
    startSession: async (schedule) => schedule.id === pendingSchedule.id
      ? pendingAgent
      : successfulAgent([], false, schedule.target),
    dispatchSchedule: (schedule, agent, observeRun) => dispatchScheduleToAgent(
      schedule,
      agent,
      5,
      5,
      observeRun,
    ),
    now: () => now,
  };

  const startedAt = Date.now();
  const firstPass = await runSchedulePass(
    fixture.store,
    "live-leader",
    dependencies,
    1,
    { claimLeaseMs: 1_000, heartbeatIntervalMs: 20, pendingRunRegistry: pendingRuns },
  );
  assert.deepEqual(firstPass, { claimed: 1, succeeded: 0, failed: 0, deferred: 1 });
  assert.ok(Date.now() - startedAt < 1_000, "the dispatcher pass stayed blocked on the late terminal");
  const pending = (await fixture.store.read()).schedules.find((entry) => entry.id === pendingSchedule.id);
  assert.equal(pending?.state, "pending-terminal");
  assert.equal(pendingRuns.size, 1);
  assert.equal(pendingRuns.list()[0]?.status, "pending-terminal");
  const originalRunId = pending?.claim?.runId;
  assert.equal(typeof originalRunId, "string");

  for (let cycle = 0; cycle < 3; cycle++) {
    now += 800;
    const deadline = Date.now() + 1_000;
    let renewed = false;
    while (Date.now() < deadline) {
      const current = (await fixture.store.read()).schedules.find((entry) => entry.id === pendingSchedule.id);
      if (current?.claim?.runId === originalRunId && current.claim.leaseExpiresAt >= now + 1_000) {
        renewed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(renewed, true, `pending monitor heartbeat ${cycle + 1} did not renew the claim`);
    assert.deepEqual(await fixture.store.claimDue({ ownerId: "contender", now, leaseMs: 1_000 }), []);
  }

  now += 601;
  const secondPass = await runSchedulePass(
    fixture.store,
    "live-leader",
    dependencies,
    1,
    { claimLeaseMs: 1_000, heartbeatIntervalMs: 20, pendingRunRegistry: pendingRuns },
  );
  assert.deepEqual(secondPass, { claimed: 1, succeeded: 1, failed: 0, deferred: 0 });
  assert.equal((await fixture.store.read()).schedules.find((entry) => entry.id === siblingSchedule.id)?.fireCount, 1);

  resolveLateTerminal({ runId: originalRunId, runEpoch: 11, usage: { inputTokens: 2, outputTokens: 1 } });
  const terminal = await waitForSchedule(fixture.store, (schedule) => (
    schedule.id === pendingSchedule.id && schedule.fireCount === 1
  ));
  assert.equal(terminal.fireCount, 1);
  assert.equal(terminal.claim, undefined);
  assert.equal((await fixture.store.read()).schedules.find((entry) => entry.id === siblingSchedule.id)?.fireCount, 1);
  const monitorDeadline = Date.now() + 1_000;
  while (pendingRuns.size > 0 && Date.now() < monitorDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pendingRuns.size, 0);
  assert.deepEqual(await fixture.store.claimDue({ ownerId: "contender", now, leaseMs: 1_000 }), []);
});

test("invalid targets are paused and release active quota", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const now = Date.now();
  const created = await fixture.store.create({
    target: fixture.target,
    intervalSeconds: 60,
    prompt: "deleted target",
    policy: { version: 1, toolNames: [], thinkingLevel: "off" },
    nextFireAt: now,
  });
  await rm(fixture.target.sessionFile);

  const result = await runSchedulePass(fixture.store, "leader", {
    getSession: () => undefined,
    startSession: async () => { throw new Error("must not start"); },
    now: () => now + 1,
  });
  const stored = (await fixture.store.read()).schedules.find((entry) => entry.id === created.id);
  assert.equal(result.failed, 1);
  assert.equal(stored?.enabled, false);
  assert.match(stored?.pausedReason ?? "", /Invalid schedule target/);
});
