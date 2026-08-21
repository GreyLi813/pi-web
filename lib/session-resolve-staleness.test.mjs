import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

const tempDir = mkdtempSync(join(tmpdir(), "pi-session-resolve-test-"));
process.env.PI_CODING_AGENT_DIR = tempDir;

const {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  resolveSessionPath,
} = await jiti.import("./session-reader.ts");

function resetCaches() {
  invalidateSessionListCache();
  globalThis.__piSessionPathCache?.clear();
}

/** Persist a session file the way an external process (e.g. the pi CLI) would. */
function createExternalSession(cwd) {
  const manager = SessionManager.create(cwd, undefined);
  manager.appendSessionInfo("External session");
  const sessionFile = manager.persistSession();
  assert.ok(sessionFile, "session persistence must succeed in the test agent dir");
  return { sessionId: manager.getSessionId(), sessionFile };
}

test("resolveSessionPath finds externally created sessions without waiting for the list TTL", async () => {
  resetCaches();
  // Warm the 30s list TTL cache so the external creation lands inside the stale window.
  await listAllSessions();

  const external = createExternalSession(tempDir);
  const resolved = await resolveSessionPath(external.sessionId);

  assert.ok(resolved, "external session must resolve immediately, not after the 30s TTL");
  assert.equal(resolved, external.sessionFile);
});

test("resolveSessionPath heals when persistence races an in-flight cache miss", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-race-"));
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  await listAllSessions();

  const manager = SessionManager.create(workspace);
  manager.appendSessionInfo("Racing session");
  const pending = resolveSessionPath(manager.getSessionId());
  await Promise.resolve();
  const sessionFile = manager.persistSession();
  assert.ok(sessionFile);
  assert.equal(await pending, sessionFile);
  process.env.PI_CODING_AGENT_DIR = tempDir;
  rmSync(root, { recursive: true, force: true });
});

test("resolveSessionPath drops a stale path cache entry after external deletion", async () => {
  resetCaches();
  const external = createExternalSession(tempDir);
  assert.equal(await resolveSessionPath(external.sessionId), external.sessionFile);

  // Simulate an external process deleting the file: no in-process invalidation runs.
  unlinkSync(external.sessionFile);
  assert.equal(await resolveSessionPath(external.sessionId), null);
});

test("resolveSessionPath returns null after bounded self-healing rescans", async () => {
  resetCaches();
  await listAllSessions();
  invalidateSessionPathCache("019fc661-f131-79ba-bed4-7b475016e555");

  assert.equal(await resolveSessionPath("019fc661-f131-79ba-bed4-7b475016e555"), null);
});

test("cleanup", () => {
  rmSync(tempDir, { recursive: true, force: true });
});
