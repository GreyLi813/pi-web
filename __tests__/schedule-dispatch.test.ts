import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchScheduleToAgent,
  getDueSchedules,
  type PersistentSchedule,
  type ScheduleAgent,
} from "../lib/schedule-dispatch";

const baseSchedule: PersistentSchedule = {
  id: "task-a",
  intervalSeconds: 60,
  prompt: "report time",
  nextFireAt: 1_000,
  enabled: true,
  source: "persistent",
  fireCount: 0,
  sessionId: "session-a",
};

test("passes: returns all bound due schedules in chronological order", () => {
  const result = getDueSchedules([
    { ...baseSchedule, id: "later", nextFireAt: 900 },
    { ...baseSchedule, id: "earlier", nextFireAt: 700 },
    { ...baseSchedule, id: "future", nextFireAt: 1_001 },
  ], 1_000);
  assert.deepEqual(result.map((schedule) => schedule.id), ["earlier", "later"]);
});

test("fails safely: excludes unbound, disabled, and non-persistent schedules", () => {
  const result = getDueSchedules([
    { ...baseSchedule, id: "unbound", sessionId: undefined },
    { ...baseSchedule, id: "disabled", enabled: false },
    { ...baseSchedule, id: "session-only", source: "session" },
  ], 1_000);
  assert.deepEqual(result, []);
});

test("passes: submits model, thinking, and prompt as one atomic command", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const agent: ScheduleAgent = {
    isRunning: () => false,
    send: async (command) => { commands.push(command); },
  };
  const accepted = await dispatchScheduleToAgent({
    ...baseSchedule,
    modelProvider: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "max",
  }, agent);

  assert.equal(accepted, true);
  assert.deepEqual(commands, [{
    type: "scheduled_prompt",
    message: "report time",
    modelProvider: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "max",
  }]);
});

test("fails safely: a busy session receives no schedule commands", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const accepted = await dispatchScheduleToAgent(baseSchedule, {
    isRunning: () => true,
    send: async (command) => { commands.push(command); },
  });

  assert.equal(accepted, false);
  assert.deepEqual(commands, []);
});

test("fails safely: incomplete model settings reject before prompting", async () => {
  const commands: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () => dispatchScheduleToAgent({ ...baseSchedule, modelProvider: "deepseek" }, {
      isRunning: () => false,
      send: async (command) => { commands.push(command); },
    }),
    /incomplete model configuration/,
  );
  assert.deepEqual(commands, []);
});

test("passes: auto thinking uses the model default without a thinking command", async () => {
  const commands: Array<Record<string, unknown>> = [];
  await dispatchScheduleToAgent({ ...baseSchedule, thinkingLevel: "auto" }, {
    isRunning: () => false,
    send: async (command) => { commands.push(command); },
  });
  assert.deepEqual(commands, [{ type: "scheduled_prompt", message: "report time" }]);
});
