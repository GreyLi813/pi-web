import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createCodexImportTestRoot,
  createThreadsDatabase,
  createVisibleCodexRecords,
  writeCodexRollout,
} from "./codex-import-test-support.mjs";

const jiti = createJiti(import.meta.url);
const { createCodexImportService } = await jiti.import("./codex-import/service.ts");
const { CodexImportError } = await jiti.import("./codex-import/errors.ts");
const { codexImportErrorResponse, parseCodexPreflightRequest } = await jiti.import("./codex-import/http.ts");
const { validatePublishedPiSession } = await jiti.import("./codex-import/storage.ts");

const TEST_MODEL = {
  id: "gpt-5.4",
  name: "Test Codex model",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * Build a no-network model runtime sufficient for context-safe imports.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createTestModelRuntime() {
  return {
    getAvailable: async () => [TEST_MODEL],
    getModel: (provider, modelId) => provider === TEST_MODEL.provider && modelId === TEST_MODEL.id
      ? TEST_MODEL
      : undefined,
  };
}

/**
 * Create one service fixture with an authoritative root thread.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createServiceFixture(t, options = {}) {
  const fixture = createCodexImportTestRoot(t);
  const threadId = options.threadId ?? "01900000-0000-7000-8000-000000000030";
  const rolloutPath = join(fixture.codexHome, "sessions", "service.jsonl");
  const effectiveCwd = options.effectiveCwd ?? fixture.workspace;
  writeCodexRollout(
    rolloutPath,
    createVisibleCodexRecords(threadId, fixture.workspace, effectiveCwd),
  );
  createThreadsDatabase(fixture.codexHome, [{
    id: threadId,
    rolloutPath,
    cwd: fixture.workspace,
    title: "Service import fixture",
  }]);
  const service = createCodexImportService({
    agentDir: fixture.agentDir,
    codexHome: fixture.codexHome,
    createModelRuntime: async () => createTestModelRuntime(),
  });
  return { ...fixture, threadId, rolloutPath, service };
}

test("list and detail APIs expose metadata but never rollout paths, source hashes, or transcript bodies", async (t) => {
  const fixture = createServiceFixture(t);
  const sessions = await fixture.service.list({ name: "service" });
  assert.equal(sessions.length, 1);
  const detail = await fixture.service.detail(fixture.threadId);
  const responseText = JSON.stringify({ sessions, detail });

  assert.equal(Object.hasOwn(sessions[0], "rolloutPath"), false);
  assert.equal(Object.hasOwn(sessions[0], "sourceVersion"), false);
  assert.doesNotMatch(responseText, /VISIBLE_USER_REQUEST|PRIVATE_DEVELOPER_CONTEXT|fixture-version/);
  assert.equal(detail.id, fixture.threadId);
});

test("preflights and atomically imports one selected session, then deduplicates it", async (t) => {
  const fixture = createServiceFixture(t);
  const preflight = await fixture.service.preflight({ threadId: fixture.threadId });
  assert.equal(preflight.status, "ready");
  assert.ok(preflight.preflightToken);
  assert.equal(preflight.compaction.mode, "none");
  const repeatedPreflight = await fixture.service.preflight({ threadId: fixture.threadId });
  const firstTokenPayload = JSON.parse(Buffer.from(preflight.preflightToken.split(".")[0], "base64url").toString("utf8"));
  const repeatedTokenPayload = JSON.parse(Buffer.from(repeatedPreflight.preflightToken.split(".")[0], "base64url").toString("utf8"));
  assert.equal(repeatedTokenPayload.sessionId, firstTokenPayload.sessionId);
  assert.equal(repeatedTokenPayload.planHash, firstTokenPayload.planHash);

  const imported = await fixture.service.import(preflight.preflightToken);
  assert.equal(imported.status, "imported");
  const listed = await fixture.service.list();
  assert.equal(listed[0].importState, "already_imported");
  assert.equal(listed[0].importedSessionId, imported.sessionId);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  try {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const sdkSessions = await SessionManager.listAll();
    assert.ok(sdkSessions.some((session) => session.id === imported.sessionId));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }

  const sessionsRoot = join(fixture.agentDir, "sessions");
  const sessionDirectory = (await import("node:fs")).readdirSync(sessionsRoot)[0];
  const sessionFile = (await import("node:fs")).readdirSync(join(sessionsRoot, sessionDirectory))[0];
  const validation = await validatePublishedPiSession(join(sessionsRoot, sessionDirectory, sessionFile), fixture.workspace);
  assert.equal(validation.sessionId, imported.sessionId);
  assert.equal(validation.toolCallCount, validation.toolResultCount);

  const repeated = await fixture.service.preflight({ threadId: fixture.threadId });
  assert.equal(repeated.status, "already_imported");
  assert.equal(repeated.existingSessionId, imported.sessionId);
});

test("honors cancellation before the atomic publication commit point", async (t) => {
  const fixture = createServiceFixture(t, {
    threadId: "01900000-0000-7000-8000-00000000003b",
  });
  const preflight = await fixture.service.preflight({ threadId: fixture.threadId });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => fixture.service.import(preflight.preflightToken, controller.signal),
    (error) => error instanceof CodexImportError && error.code === "IMPORT_CANCELLED",
  );
  const detail = await fixture.service.detail(fixture.threadId);
  assert.equal(detail.importState, "available");
});

test("binds preflight to the real model API endpoint fingerprint", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-00000000003a";
  const rolloutPath = join(fixture.codexHome, "sessions", "endpoint-bound.jsonl");
  writeCodexRollout(rolloutPath, createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace));
  createThreadsDatabase(fixture.codexHome, [{
    id: threadId,
    rolloutPath,
    cwd: fixture.workspace,
    title: "Endpoint bound",
  }]);
  let authBaseUrl = "https://gateway.example.invalid/TenantA";
  const service = createCodexImportService({
    agentDir: fixture.agentDir,
    codexHome: fixture.codexHome,
    createModelRuntime: async () => {
      const model = { ...TEST_MODEL, baseUrl: "https://model-default.example.invalid" };
      return {
        getAvailable: async () => [model],
        getModel: (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined,
        getAuth: async () => ({
          auth: {
            apiKey: "test-secret",
            baseUrl: authBaseUrl,
            headers: { "X-Test-Route": "tenant-a" },
          },
        }),
      };
    },
  });
  const preflight = await service.preflight({ threadId });
  authBaseUrl = "https://gateway.example.invalid/tenanta";
  await assert.rejects(
    () => service.import(preflight.preflightToken),
    (error) => error instanceof CodexImportError && error.code === "PREFLIGHT_PLAN_CHANGED",
  );
});

test("source changes require explicit reimport and create a new Pi session without overwriting the old one", async (t) => {
  const fixture = createServiceFixture(t);
  const firstPlan = await fixture.service.preflight({ threadId: fixture.threadId });
  const first = await fixture.service.import(firstPlan.preflightToken);
  appendFileSync(fixture.rolloutPath, `${JSON.stringify({
    timestamp: "2026-01-01T00:00:04.000Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 } } },
  })}\n`);

  await assert.rejects(
    () => fixture.service.preflight({ threadId: fixture.threadId }),
    (error) => error instanceof CodexImportError && error.code === "SOURCE_CHANGED_CONFIRMATION_REQUIRED",
  );
  const changedPlan = await fixture.service.preflight({
    threadId: fixture.threadId,
    reimportChanged: true,
  });
  const second = await fixture.service.import(changedPlan.preflightToken);
  assert.equal(second.status, "imported");
  assert.notEqual(second.sessionId, first.sessionId);
});

test("missing source cwd blocks preflight until DirectoryPicker supplies an explicit remap", async (t) => {
  const fixtureRoot = createCodexImportTestRoot(t);
  const missingCwd = join(fixtureRoot.root, "missing-cwd");
  const remap = join(fixtureRoot.root, "selected-remap");
  mkdirSync(remap);
  const threadId = "01900000-0000-7000-8000-000000000031";
  const rolloutPath = join(fixtureRoot.codexHome, "sessions", "missing-cwd.jsonl");
  writeCodexRollout(
    rolloutPath,
    createVisibleCodexRecords(threadId, missingCwd, missingCwd),
  );
  createThreadsDatabase(fixtureRoot.codexHome, [{
    id: threadId,
    rolloutPath,
    cwd: missingCwd,
    title: "Missing cwd fixture",
  }]);
  const service = createCodexImportService({
    agentDir: fixtureRoot.agentDir,
    codexHome: fixtureRoot.codexHome,
    createModelRuntime: async () => createTestModelRuntime(),
  });

  await assert.rejects(
    () => service.preflight({ threadId }),
    (error) => error instanceof CodexImportError && error.code === "CWD_REMAP_REQUIRED",
  );
  const remapped = await service.preflight({ threadId, remapCwd: remap });
  assert.equal(remapped.targetCwd, remap);
});

test("HTTP errors never echo unknown transcript or path diagnostics", async () => {
  const unknown = codexImportErrorResponse(new Error("VISIBLE_USER_REQUEST D:/private/rollout.jsonl"));
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.code, "CODEX_IMPORT_FAILED");
  assert.doesNotMatch(JSON.stringify(unknownBody), /VISIBLE_USER_REQUEST|private|rollout\.jsonl/);

  const structured = codexImportErrorResponse(new CodexImportError(
    "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
    "Choose a model",
    {
      availableModels: [{ provider: "anthropic", modelId: "claude-long" }],
      transcript: "PRIVATE_DEVELOPER_CONTEXT",
    },
  ));
  const structuredBody = await structured.json();
  assert.deepEqual(structuredBody.details, {
    availableModels: [{ provider: "anthropic", modelId: "claude-long" }],
  });
  assert.doesNotMatch(JSON.stringify(structuredBody), /PRIVATE_DEVELOPER_CONTEXT/);
});

test("HTTP parser enforces its body limit without Content-Length", async () => {
  const request = new Request("http://localhost:30142/api/codex-import/preflight", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:30142" },
    body: JSON.stringify({ threadId: "x".repeat(40_000) }),
  });
  assert.equal(request.headers.has("content-length"), false);
  await assert.rejects(
    () => parseCodexPreflightRequest(request),
    (error) => error instanceof CodexImportError && error.code === "REQUEST_TOO_LARGE",
  );
});

test("HTTP parser rejects production directory and other server-root override fields", async () => {
  const request = new Request("http://localhost:30142/api/codex-import/preflight", {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:30142" },
    body: JSON.stringify({
      threadId: "thread",
      productionAgentDir: "D:/attempted-bypass",
    }),
  });
  await assert.rejects(
    () => parseCodexPreflightRequest(request),
    (error) => error instanceof CodexImportError && error.code === "INVALID_REQUEST",
  );
});
