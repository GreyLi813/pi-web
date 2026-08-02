import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  AgentSessionWrapper,
  reserveRpcSessionDeletion,
  startRpcSession,
} = await jiti.import("./rpc-manager.ts");

/** Create the minimal AgentSession surface used by orchestration RPC commands.
 * @author GPT-5.6 Sol
 */
function createInner(options = {}) {
  let lastText = "";
  const activeTools = [];
  const messages = [];
  const inner = {
    sessionId: "worker-rpc",
    sessionFile: "worker.jsonl",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    pendingMessageCount: 0,
    messages,
    model: { provider: "old", id: "old-model" },
    modelRuntime: {
      getModel: (provider, modelId) => ({ provider, id: modelId }),
      refresh: async () => {},
    },
    agent: {
      state: { systemPrompt: "system", thinkingLevel: "off" },
      convertToLlm: (messages) => messages,
    },
    setModel: async (model) => { inner.model = model; },
    setThinkingLevel: (level) => { inner.agent.state.thinkingLevel = level; },
    prompt: async (message) => {
      inner.isStreaming = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
      inner.isStreaming = false;
      if (options.fail) throw new Error("worker model failed");
      if (options.modelError) {
        messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage: "provider rejected request" });
        return;
      }
      lastText = `done:${message}`;
      messages.push({ role: "assistant", content: [{ type: "text", text: lastText }], stopReason: "stop" });
    },
    abort: async () => { inner.isStreaming = false; },
    getLastAssistantText: () => lastText,
    setActiveToolsByName: (names) => {
      activeTools.splice(0, activeTools.length, ...names);
    },
    getAllTools: () => [],
    getActiveToolNames: () => [...activeTools],
    getContextUsage: () => undefined,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    clearQueue: () => ({ steering: [], followUp: [] }),
  };
  return { inner, activeTools };
}

test("orchestrated_prompt atomically applies settings and waits for the complete worker response", async () => {
  const { inner } = createInner();
  const wrapper = new AgentSessionWrapper(inner);

  const result = await wrapper.send({
    type: "orchestrated_prompt",
    message: "validate",
    modelProvider: "test",
    modelId: "review-model",
    thinkingLevel: "high",
  });

  assert.deepEqual(result, { text: "done:validate" });
  assert.deepEqual(inner.model, { provider: "test", id: "review-model" });
  assert.equal(inner.agent.state.thinkingLevel, "high");
  assert.equal(wrapper.isRunning(), false);
  wrapper.destroy();
});

test("orchestrated_prompt rejects model failures and releases the worker lock", async () => {
  const { inner } = createInner({ fail: true });
  const wrapper = new AgentSessionWrapper(inner);

  await assert.rejects(
    () => wrapper.send({ type: "orchestrated_prompt", message: "fail" }),
    /worker model failed/,
  );
  assert.equal(wrapper.isRunning(), false);
  wrapper.destroy();
});

test("orchestrated_prompt treats a resolved assistant error as a failed worker turn", async () => {
  const { inner } = createInner({ modelError: true });
  const wrapper = new AgentSessionWrapper(inner);

  await assert.rejects(
    () => wrapper.send({ type: "orchestrated_prompt", message: "fail in provider" }),
    /provider rejected request/,
  );
  assert.equal(wrapper.isRunning(), false);
  wrapper.destroy();
});

test("set_tools_exact does not reactivate extension tools for restricted workers", async () => {
  const { inner, activeTools } = createInner();
  const wrapper = new AgentSessionWrapper(inner);

  await wrapper.send({ type: "set_tools_exact", toolNames: ["read", "grep"] });
  assert.deepEqual(activeTools, ["read", "grep"]);

  await wrapper.send({ type: "set_tools_exact", toolNames: [], preserveSystemPrompt: true });
  assert.equal(inner.agent.state.systemPrompt, "system");
  await wrapper.send({ type: "set_tools_exact", toolNames: [] });
  assert.equal(inner.agent.state.systemPrompt, "");
  wrapper.destroy();
});

test("imported sessions expose exactly Pi's four defaults after extension binding", async () => {
  const { inner, activeTools } = createInner();
  inner.bindExtensions = async () => {
    inner.setActiveToolsByName(["read", "bash", "edit", "write", "extension_tool"]);
  };
  const wrapper = new AgentSessionWrapper(
    inner,
    undefined,
    ["read", "bash", "edit", "write"],
  );

  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);

  await wrapper.send({ type: "set_tools_exact", toolNames: ["read", "grep"] });
  assert.deepEqual(activeTools, ["read", "grep"], "the existing tool UI could not override the initial preset");
  wrapper.destroy();
});

test("persisted worker policy governs generic API commands and every normal turn", async () => {
  const { inner, activeTools } = createInner();
  const wrapper = new AgentSessionWrapper(inner, {
    toolNames: [],
    model: { provider: "fixed", modelId: "fixed-model" },
    thinkingLevel: "high",
  });

  await assert.rejects(
    () => wrapper.send({ type: "set_tools", toolNames: ["read", "bash", "edit", "write"] }),
    /tool profile cannot be changed/,
  );
  await assert.rejects(
    () => wrapper.send({ type: "set_model", provider: "other", modelId: "other-model" }),
    /model cannot be changed/,
  );
  await assert.rejects(
    () => wrapper.send({ type: "bash", command: "echo unsafe" }),
    /does not allow shell commands/,
  );

  await wrapper.send({ type: "prompt", message: "normal worker turn" });
  await assert.rejects(
    () => wrapper.send({ type: "prompt", message: "overlapping turn" }),
    /session is busy/,
  );
  assert.deepEqual(inner.model, { provider: "fixed", id: "fixed-model" });
  assert.equal(inner.agent.state.thinkingLevel, "high");
  assert.deepEqual(activeTools, []);
  assert.equal(inner.agent.state.systemPrompt, "system");
  await new Promise((resolve) => setTimeout(resolve, 35));
  wrapper.destroy();
});

test("deletion reservations reject in-flight startup and block new runtimes", async () => {
  globalThis.__piStartLocks = new Map([["starting-session", Promise.resolve({})]]);
  try {
    assert.equal(reserveRpcSessionDeletion("starting-session"), undefined);
    globalThis.__piStartLocks.delete("starting-session");

    const deletion = reserveRpcSessionDeletion("deleting-session");
    assert.ok(deletion);
    await assert.rejects(
      () => startRpcSession("deleting-session", "", process.cwd()),
      /being deleted/,
    );
    deletion.release();
  } finally {
    globalThis.__piStartLocks?.delete("starting-session");
    globalThis.__piDeletingSessions?.delete("deleting-session");
  }
});

test("orchestrated turns reserve mutable runtime settings until completion", async () => {
  const { inner } = createInner();
  const wrapper = new AgentSessionWrapper(inner);
  const running = wrapper.send({ type: "orchestrated_prompt", message: "slow" });
  await new Promise((resolve) => setTimeout(resolve, 5));

  await assert.rejects(
    () => wrapper.send({ type: "set_model", provider: "other", modelId: "other-model" }),
    /session is busy/,
  );
  await assert.rejects(
    () => wrapper.send({ type: "steer", message: "interfere" }),
    /Cannot steer/,
  );
  await assert.rejects(
    () => wrapper.send({ type: "compact" }),
    /session is busy/,
  );
  await running;
  wrapper.destroy();
});
