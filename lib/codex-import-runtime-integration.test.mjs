import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createThreadsDatabase,
  createVisibleCodexRecords,
  writeCodexRollout,
} from "./codex-import-test-support.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-web-codex-runtime-"));
const codexHome = join(root, ".codex");
const agentDir = join(root, ".pi-agent");
const workspace = join(root, "workspace");
mkdirSync(join(codexHome, "sessions"), { recursive: true });
mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createCodexImportService } = await jiti.import("./codex-import/service.ts");
const { startRpcSession } = await jiti.import("./rpc-manager.ts");

const TEST_MODEL = {
  id: "gpt-5.4",
  name: "Runtime test model",
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
 * Find one imported JSONL without following linked directories.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function findSessionFile(directory, sessionId) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findSessionFile(path, sessionId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) {
      return path;
    }
  }
  return undefined;
}

test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("cold-starts an imported session with four Pi tools and isolated provider history", async () => {
  const threadId = "01900000-0000-7000-8000-000000000095";
  const rolloutPath = join(codexHome, "sessions", "runtime.jsonl");
  writeCodexRollout(
    rolloutPath,
    createVisibleCodexRecords(threadId, workspace, workspace),
  );
  createThreadsDatabase(codexHome, [{
    id: threadId,
    rolloutPath,
    cwd: workspace,
    title: "Runtime policy fixture",
  }]);
  const service = createCodexImportService({
    agentDir,
    codexHome,
    createModelRuntime: async () => ({
      getAvailable: async () => [TEST_MODEL],
      getModel: (provider, modelId) => provider === TEST_MODEL.provider && modelId === TEST_MODEL.id
        ? TEST_MODEL
        : undefined,
    }),
  });
  const preflight = await service.preflight({ threadId });
  const imported = await service.import(preflight.preflightToken);
  const sessionFile = findSessionFile(join(agentDir, "sessions"), imported.sessionId);
  assert.ok(sessionFile);
  const diskBefore = readFileSync(sessionFile, "utf8");
  assert.match(diskBefore, /"type":"toolCall"/);
  assert.match(diskBefore, /"role":"toolResult"/);

  const { session } = await startRpcSession(imported.sessionId, sessionFile, workspace);
  try {
    await session.waitUntilReady();
    const tools = await session.send({ type: "get_tools" });
    assert.deepEqual(
      tools.filter((tool) => tool.active).map((tool) => tool.name),
      ["read", "bash", "edit", "write"],
    );

    const projected = await session.inner.agent.convertToLlm(session.inner.messages);
    assert.ok(projected.every((message) => message.role !== "toolResult"
      || !message.toolName.startsWith("codex_")));
    assert.ok(projected.every((message) => message.role !== "assistant"
      || message.content.every((block) => block.type !== "toolCall" || !block.name.startsWith("codex_"))));
    assert.equal(readFileSync(sessionFile, "utf8"), diskBefore, "runtime projection rewrote imported JSONL");
  } finally {
    session.destroy();
  }
});
