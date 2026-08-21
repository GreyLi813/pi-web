import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Read one Pi-Web source file relative to this test.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("generic Agent commands reject both peer and worker wrappers", async () => {
  const route = await source("../app/api/agent/[id]/route.ts");
  assert.match(route, /isRestrictedModelControlledSession\(\)/);
  assert.match(route, /peer Sessions? can only be accessed through peer owner authority/i);
});

test("generic schedule mutations reject peer-owned targets", async () => {
  const route = await source("../app/api/schedules/route.ts");
  assert.match(route, /assertGenericScheduleMutationAllowed/);
  assert.match(route, /peer Sessions? can only be scheduled through their owning controller/i);
});

test("rename, auto-name, and delete share the peer and worker restriction", async () => {
  const sessionRoute = await source("../app/api/sessions/[id]/route.ts");
  const autoNameRoute = await source("../app/api/sessions/[id]/auto-name/route.ts");
  const chatWindow = await source("../components/ChatWindow.tsx");
  assert.match(sessionRoute, /isRestrictedModelControlledSession\(\)/);
  assert.match(sessionRoute, /assertGenericSessionMutationAllowed/);
  assert.match(autoNameRoute, /isRestrictedModelControlledSession\(\)/);
  assert.match(autoNameRoute, /peer/i);
  assert.match(chatWindow, /model-controlled Session is read-only here/);
  assert.match(chatWindow, /use its peer\/worker tools/);
});
