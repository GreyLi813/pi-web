import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchScheduleToAgent,
  getDueSchedules,
  ScheduleRunTerminalUnconfirmedError,
  type PersistentSchedule,
  type ScheduleAgent,
} from "../lib/schedule-dispatch.ts";

const baseSchedule: PersistentSchedule = {
  id: "task-a",
  intervalSeconds: 60,
  prompt: "report time",
  nextFireAt: 1_000,
  enabled: true,
  state: "claimed",
  source: "persistent",
  createdAt: 1,
  updatedAt: 1,
  fireCount: 0,
  failureCount: 0,
  nextAttempt: 1,
  runEpoch: 1,
  target: {
    version: 1,
    sessionId: "session-a",
    sessionFile: "D:/sessions/session-a.jsonl",
    sessionDir: "D:/sessions",
    cwd: "D:/work",
    fileKey: "1:2:3",
  },
  policy: {
    version: 1,
    toolNames: [],
    model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
    thinkingLevel: "max",
    endpointFingerprint: "a".repeat(64),
  },
  budget: { maxCalls: 100, maxConcurrentRuns: 1, maxRetries: 2 },
  usage: { calls: 0, retries: 0, inputTokens: 0, outputTokens: 0 },
  claim: {
    ownerId: "leader",
    runId: "claimed-run",
    runEpoch: 1,
    attempt: 1,
    claimedAt: 1,
    leaseExpiresAt: 100_000,
  },
};

test("returns only scheduled due entries in chronological order", () => {
  const scheduled = { ...baseSchedule, state: "scheduled" as const, claim: undefined };
  const result = getDueSchedules([
    { ...scheduled, id: "later", nextFireAt: 900 },
    { ...scheduled, id: "earlier", nextFireAt: 700 },
    { ...scheduled, id: "future", nextFireAt: 1_001 },
    { ...scheduled, id: "disabled", enabled: false },
  ], 1_000);
  assert.deepEqual(result.map((schedule) => schedule.id), ["earlier", "later"]);
});

test("submits exact policy and waits for matching terminal run identity", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const agent: ScheduleAgent = {
    sessionFile: baseSchedule.target.sessionFile,
    sessionFileKey: baseSchedule.target.fileKey,
    isRunning: () => false,
    send: async (command) => {
      commands.push(command);
      if (command.type === "get_state") return { runEpoch: 9 };
      return { runId: "claimed-run", runEpoch: 10, usage: { inputTokens: 8, outputTokens: 3 } };
    },
  };
  const result = await dispatchScheduleToAgent(baseSchedule, agent);

  assert.deepEqual(result, {
    runId: "claimed-run",
    runEpoch: 10,
    usage: { inputTokens: 8, outputTokens: 3, costUsd: undefined },
  });
  assert.deepEqual(commands, [
    { type: "get_state" },
    {
      type: "scheduled_prompt",
      message: "report time",
      runId: "claimed-run",
      runEpoch: 10,
      toolNames: [],
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "max",
      endpointFingerprint: "a".repeat(64),
    },
  ]);
});

test("busy and orchestrated targets receive no commands", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const busy = await dispatchScheduleToAgent(baseSchedule, {
    isRunning: () => true,
    send: async (command) => { commands.push(command); },
  });
  const worker = await dispatchScheduleToAgent(baseSchedule, {
    isRunning: () => false,
    isOrchestratedWorker: () => true,
    send: async (command) => { commands.push(command); },
  });
  assert.equal(busy, null);
  assert.equal(worker, null);
  assert.deepEqual(commands, []);
});

test("a timed-out run returns a non-rejecting observer that retains the late exact terminal", async () => {
  const commands: Array<Record<string, unknown>> = [];
  let resolvePrompt!: (value: unknown) => void;
  const promptTerminal = new Promise((resolve) => { resolvePrompt = resolve; });
  const agent: ScheduleAgent = {
    sessionFile: baseSchedule.target.sessionFile,
    sessionFileKey: baseSchedule.target.fileKey,
    isRunning: () => false,
    send: async (command) => {
      commands.push(command);
      if (command.type === "get_state") return { runEpoch: 4 };
      if (command.type === "cancel_run") return { cancelled: false };
      return promptTerminal;
    },
  };
  let unconfirmed: ScheduleRunTerminalUnconfirmedError | undefined;
  try {
    await dispatchScheduleToAgent(baseSchedule, agent, 5, 5);
  } catch (error) {
    if (error instanceof ScheduleRunTerminalUnconfirmedError) unconfirmed = error;
    else throw error;
  }
  assert.ok(unconfirmed);
  assert.deepEqual(commands.at(-1), {
    type: "cancel_run",
    runId: "claimed-run",
    runEpoch: 5,
  });
  resolvePrompt({ runId: "claimed-run", runEpoch: 5, usage: { inputTokens: 3, outputTokens: 2 } });
  assert.deepEqual(await unconfirmed.observer.terminal, {
    status: "succeeded",
    result: {
      runId: "claimed-run",
      runEpoch: 5,
      usage: { inputTokens: 3, outputTokens: 2, costUsd: undefined },
    },
  });
});

test("a delayed cancellation waits for the exact prompt terminal before reporting failure", async () => {
  let rejectPrompt!: (error: Error) => void;
  const commands: Array<Record<string, unknown>> = [];
  const terminal = new Promise<never>((_resolve, reject) => { rejectPrompt = reject; });
  const agent: ScheduleAgent = {
    sessionFile: baseSchedule.target.sessionFile,
    sessionFileKey: baseSchedule.target.fileKey,
    isRunning: () => false,
    send: async (command) => {
      commands.push(command);
      if (command.type === "get_state") return { runEpoch: 6 };
      if (command.type === "cancel_run") {
        setTimeout(() => rejectPrompt(new Error("scheduled run aborted")), 10);
        return new Promise((resolve) => setTimeout(() => resolve({ cancelled: true }), 10));
      }
      return terminal;
    },
  };
  await assert.rejects(
    () => dispatchScheduleToAgent(baseSchedule, agent, 5, 50),
    /scheduled run aborted/,
  );
  assert.deepEqual(commands.at(-1), {
    type: "cancel_run",
    runId: "claimed-run",
    runEpoch: 7,
  });
});

test("rejects a wrapper for a different physical Session", async () => {
  await assert.rejects(
    () => dispatchScheduleToAgent(baseSchedule, {
      sessionFile: "D:/sessions/other.jsonl",
      sessionFileKey: baseSchedule.target.fileKey,
      isRunning: () => false,
      send: async () => ({ runEpoch: 0 }),
    }),
    /does not match/,
  );
  await assert.rejects(
    () => dispatchScheduleToAgent(baseSchedule, {
      sessionFile: baseSchedule.target.sessionFile,
      sessionFileKey: "replacement-file-key",
      isRunning: () => false,
      send: async () => ({ runEpoch: 0 }),
    }),
    /physical identity|file key/i,
  );
});
