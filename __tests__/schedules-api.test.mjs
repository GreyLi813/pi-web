/**
 * Pi-Web ScheduleStore integration tests.
 *
 * Every mutation goes through coding-agent's one strict store implementation;
 * direct file writes below are used only to inject corrupt input.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Create one isolated strict store and verifier-issued target.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-schedule-api-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const manager = SessionManager.create(root, sessionDir);
  manager.appendSessionInfo("Schedule API target");
  const sessionFile = manager.persistSession();
  if (!sessionFile) throw new Error("Test Session did not persist");
  const target = await verifySessionTarget({
    sessionId: manager.getSessionId(),
    sessionFile,
    sessionDir,
    cwd: root,
    rejectOrchestration: true,
  });
  return { agentDir, target, store: new ScheduleStore(agentDir) };
}

test("pending-terminal status and exact cancel are exposed through the API and panel", async () => {
  const route = await readFile(new URL("../app/api/schedules/route.ts", import.meta.url), "utf8");
  const panel = await readFile(new URL("../components/SchedulesPanel.tsx", import.meta.url), "utf8");
  assert.match(route, /requestPersistentScheduleRunCancel/);
  assert.match(route, /action === "cancel"/);
  assert.match(panel, /pending-terminal/);
  assert.match(panel, /Retry cancellation of the exact active run/);
});

test("creates, pauses, edits, resumes, and removes only through ScheduleStore", async (context) => {
  const { store, target } = await fixture(context);
  const created = await store.create({
    target,
    intervalSeconds: 300,
    prompt: "check status",
    policy: { version: 1, toolNames: [], thinkingLevel: "off" },
  });
  assert.equal((await store.read()).schedules.length, 1);
  await store.pause(created.id);
  const edited = await store.update(created.id, { intervalSeconds: 600, prompt: "updated" });
  assert.equal(edited.prompt, "updated");
  assert.equal(edited.intervalSeconds, 600);
  assert.equal((await store.resume(created.id)).enabled, true);
  await store.pause(created.id);
  assert.equal((await store.remove(created.id)).id, created.id);
  assert.deepEqual((await store.read()).schedules, []);
});

test("corrupt JSON and unknown versions fail closed instead of becoming empty", async (context) => {
  const { agentDir, store } = await fixture(context);
  await mkdir(agentDir, { recursive: true });
  await writeFile(store.filePath, "not valid json {{{", "utf8");
  await assert.rejects(() => store.read(), /invalid JSON/);
  await writeFile(store.filePath, JSON.stringify({ version: 99, schedules: [], updatedAt: Date.now() }), "utf8");
  await assert.rejects(() => store.read(), /Unsupported ScheduleStore version/);
});

test("paused entries still consume the bounded global and per-Session quota", async (context) => {
  const { store, target } = await fixture(context);
  for (let index = 0; index < 16; index++) {
    const entry = await store.create({
      target,
      intervalSeconds: 60,
      prompt: `task ${index}`,
      policy: { version: 1, toolNames: [], thinkingLevel: "off" },
      enabled: false,
    });
    assert.equal(entry.enabled, false);
  }
  await assert.rejects(
    () => store.create({
      target,
      intervalSeconds: 60,
      prompt: "overflow",
      policy: { version: 1, toolNames: [], thinkingLevel: "off" },
      enabled: false,
    }),
    /cannot own more than 16 schedules/,
  );
});
