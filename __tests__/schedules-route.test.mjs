import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.PI_WEB_TEST_URL ?? "http://127.0.0.1:30142";
const createdIds = new Set();

/** Send JSON to the isolated schedules endpoint.
 *
 * @author OpenAI Codex
 * @version 2.0.0
 */
async function post(body) {
  return fetch(`${baseUrl}/api/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Remove only schedules created by this test process.
 *
 * @author OpenAI Codex
 * @version 2.0.0
 */
async function cleanup() {
  await Promise.all(Array.from(createdIds, (id) => (
    fetch(`${baseUrl}/api/schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" })
  )));
  createdIds.clear();
}

test.before(async () => {
  const response = await fetch(`${baseUrl}/api/runtime`);
  assert.equal(response.status, 200, `isolated Pi-Web is not available at ${baseUrl}`);
  const runtime = await response.json();
  assert.equal(runtime.mode, "test");
  assert.equal(runtime.piAgent?.sourceMatches, true);
});

test.afterEach(cleanup);

test("fails: rejects schedule without sessionId", async () => {
  const response = await post({ intervalSeconds: 60, prompt: "test" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /sessionId/);
});

test("fails: rejects partial model configuration", async () => {
  const response = await post({
    intervalSeconds: 60,
    prompt: "test",
    sessionId: "route-test-session",
    modelProvider: "deepseek",
  });
  assert.equal(response.status, 400);
});

test("fails: rejects unsupported thinking level", async () => {
  const response = await post({
    intervalSeconds: 60,
    prompt: "test",
    sessionId: "route-test-session",
    thinkingLevel: "impossible",
  });
  assert.equal(response.status, 400);
});

test("passes: pauses, edits, and manually resumes a bound schedule", async () => {
  const createResponse = await post({
    intervalSeconds: 3_600,
    prompt: "route integration test",
    sessionId: "route-test-session",
    modelProvider: "deepseek",
    modelId: "deepseek-v4-flash",
    thinkingLevel: "max",
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).schedule;
  createdIds.add(created.id);

  const pauseResponse = await post({ id: created.id, action: "pause" });
  assert.equal(pauseResponse.status, 200);
  const paused = (await pauseResponse.json()).schedule;
  assert.equal(paused.enabled, false);
  assert.equal(paused.nextFireAt, created.nextFireAt);

  const editResponse = await post({
    id: created.id,
    action: "update",
    intervalSeconds: 7_200,
    prompt: "updated route integration test",
    modelProvider: "deepseek",
    modelId: "deepseek-v4-pro",
    thinkingLevel: "off",
  });
  assert.equal(editResponse.status, 200);
  const edited = (await editResponse.json()).schedule;
  assert.equal(edited.enabled, false);
  assert.equal(edited.intervalSeconds, 7_200);
  assert.equal(edited.prompt, "updated route integration test");
  assert.equal(edited.modelId, "deepseek-v4-pro");
  assert.equal(edited.thinkingLevel, "off");
  assert.equal(edited.sessionId, "route-test-session");
  assert.equal(edited.fireCount, created.fireCount);
  assert.equal(edited.createdAt, created.createdAt);
  assert.equal(edited.nextFireAt, created.nextFireAt);
  assert.equal(edited.lastFiredAt, created.lastFiredAt);

  const resumeStartedAt = Date.now();
  const resumeResponse = await post({ id: created.id, action: "resume" });
  const resumeFinishedAt = Date.now();
  assert.equal(resumeResponse.status, 200);
  const resumed = (await resumeResponse.json()).schedule;
  assert.equal(resumed.enabled, true);
  assert.ok(resumed.nextFireAt >= resumeStartedAt + 7_200_000);
  assert.ok(resumed.nextFireAt <= resumeFinishedAt + 7_200_000);
  assert.equal(resumed.fireCount, created.fireCount);
  assert.equal(resumed.sessionId, "route-test-session");

  const getResponse = await fetch(`${baseUrl}/api/schedules`);
  assert.equal(getResponse.status, 200);
  const stored = (await getResponse.json()).schedules.find((entry) => entry.id === created.id);
  assert.deepEqual(stored, resumed);

  const deleteResponse = await fetch(`${baseUrl}/api/schedules?id=${encodeURIComponent(created.id)}`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 200);
  createdIds.delete(created.id);
});

test("fails safely: a running schedule cannot be reconfigured", async () => {
  const createResponse = await post({
    intervalSeconds: 3_600,
    prompt: "running schedule",
    sessionId: "route-test-session",
  });
  const created = (await createResponse.json()).schedule;
  createdIds.add(created.id);

  const response = await post({ id: created.id, action: "update", prompt: "must not change" });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Pause/);
});

test("fails safely: editing cannot change a schedule's session binding", async () => {
  const createResponse = await post({
    intervalSeconds: 3_600,
    prompt: "owned schedule",
    sessionId: "original-session",
  });
  const created = (await createResponse.json()).schedule;
  createdIds.add(created.id);
  await post({ id: created.id, action: "pause" });

  const response = await post({
    id: created.id,
    action: "update",
    prompt: "new prompt",
    sessionId: "other-session",
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot be changed/);
});

test("fails: DELETE rejects a missing id", async () => {
  const response = await fetch(`${baseUrl}/api/schedules`, { method: "DELETE" });
  assert.equal(response.status, 400);
});
