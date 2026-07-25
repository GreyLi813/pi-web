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

test.after(cleanup);

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

test("passes: creates, reads, updates, and deletes a bound schedule", async () => {
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
  assert.equal(created.sessionId, "route-test-session");
  assert.equal(created.modelId, "deepseek-v4-flash");
  assert.equal(created.thinkingLevel, "max");

  const getResponse = await fetch(`${baseUrl}/api/schedules`);
  assert.equal(getResponse.status, 200);
  const stored = (await getResponse.json()).schedules.find((entry) => entry.id === created.id);
  assert.equal(stored.sessionId, "route-test-session");

  const updateResponse = await post({ id: created.id, enabled: false });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).schedule.enabled, false);

  const deleteResponse = await fetch(`${baseUrl}/api/schedules?id=${encodeURIComponent(created.id)}`, {
    method: "DELETE",
  });
  assert.equal(deleteResponse.status, 200);
  createdIds.delete(created.id);
});

test("fails: DELETE rejects a missing id", async () => {
  const response = await fetch(`${baseUrl}/api/schedules`, { method: "DELETE" });
  assert.equal(response.status, 400);
});
