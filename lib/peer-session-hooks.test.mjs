import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createWebPeerSessionHooks } = await jiti.import("./peer-session-hooks.ts");

/** Build one precise peer request for hook behavior tests.
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
function peerRequest(overrides = {}) {
  return {
    version: 2,
    target: {
      identity: {
        sessionId: "peer-1",
        sessionFile: "D:/work/sessions/peer-1.jsonl",
        sessionDir: "D:/work/sessions",
        cwd: "D:/work",
        fileKey: "10:20:30",
      },
      runtimeAuthority: { capability: "peer-authority" },
    },
    sessionId: "peer-1",
    sessionFile: "D:/work/sessions/peer-1.jsonl",
    cwd: "D:/work",
    prompt: "hello",
    projectTrusted: true,
    agentDir: "D:/agent",
    runId: "peer-run-1",
    ...overrides,
  };
}

/** Build versioned hooks and a minimal run-epoch-aware wrapper.
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
function createHooks(overrides = {}) {
  const calls = [];
  const agent = {
    sessionFile: "D:/work/sessions/peer-1.jsonl",
    sessionFileKey: "10:20:30",
    alive: true,
    running: false,
    sent: [],
    isAlive() { return this.alive; },
    isRunning() { return this.running; },
    async shutdownIfIdleAndEmpty() {
      if (!this.alive || this.running) return false;
      this.sent.push({ type: "close_session" });
      this.alive = false;
      return true;
    },
    async send(command) {
      this.sent.push(command);
      if (command.type === "get_state") return { runEpoch: 4 };
      if (command.type === "peer_prompt_and_wait") return { text: "peer reply", runEpoch: 5 };
      if (command.type === "cancel_run") return { cancelled: true };
      return null;
    },
  };
  const hooks = createWebPeerSessionHooks({
    agentDir: "D:/agent",
    startSession: async (request) => {
      calls.push([
        "start",
        request.sessionId,
        request.sessionFile,
        request.cwd,
        request.target.identity.fileKey,
        request.target.runtimeAuthority,
      ]);
      agent.sessionFile = request.sessionFile;
      agent.sessionFileKey = request.target.identity.fileKey;
      agent.alive = true;
      return { agent, created: true };
    },
    getSession: () => agent,
    cacheSessionPath: (sessionId, sessionFile) => calls.push(["cache", sessionId, sessionFile]),
    invalidateSessionPath: (sessionId) => calls.push(["drop", sessionId]),
    invalidateSessionList: () => calls.push(["invalidate"]),
    ...overrides,
  });
  return { hooks, calls, agent };
}

test("peer creation hook caches only the verified exact Session file", async () => {
  const { hooks, calls } = createHooks();
  const descriptor = {
    sessionId: "peer-1",
    sessionFile: "D:/work/sessions/peer-1.jsonl",
    name: "Peer",
    cwd: "D:/work",
    toolNames: [],
    depth: 1,
  };
  const target = { identity: { sessionFile: descriptor.sessionFile } };

  await hooks.onPeerSessionCreated?.(descriptor, target);
  assert.deepEqual(calls, [
    ["cache", "peer-1", "D:/work/sessions/peer-1.jsonl"],
    ["invalidate"],
  ]);
});

test("peer discard hook drops exact-path cache state", async () => {
  const { hooks, calls } = createHooks();
  await hooks.onPeerSessionDiscarded?.({ sessionId: "peer-1" });
  assert.deepEqual(calls, [["drop", "peer-1"], ["invalidate"]]);
});

test("prompt hook uses the verified path and one expected server epoch", async () => {
  const { hooks, calls, agent } = createHooks();

  const reply = await hooks.promptPeerSession?.(peerRequest());

  assert.equal(reply, "peer reply");
  assert.deepEqual(calls, [["invalidate"]]);
  assert.deepEqual(agent.sent, [
    { type: "get_state" },
    {
      type: "peer_prompt_and_wait",
      message: "hello",
      runId: "peer-run-1",
      runEpoch: 5,
    },
  ]);
});

test("prompt hook starts a stopped peer by exact file and rejects a busy or mismatched wrapper", async () => {
  const { hooks, calls, agent } = createHooks();
  agent.alive = false;

  const reply = await hooks.promptPeerSession?.(peerRequest({ sessionId: "peer-2", runId: "run-2" }));
  assert.equal(reply, "peer reply");
  assert.deepEqual(calls[0], [
    "start",
    "peer-2",
    "D:/work/sessions/peer-1.jsonl",
    "D:/work",
    "10:20:30",
    peerRequest().target.runtimeAuthority,
  ]);

  agent.alive = true;
  agent.running = true;
  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /busy/);
  agent.running = false;
  agent.sessionFile = "D:/work/sessions/other.jsonl";
  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /does not match/);
  agent.sessionFile = "D:/work/sessions/peer-1.jsonl";
  agent.sessionFileKey = "replacement-file-key";
  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /physical identity|file key/i);
});

test("a scheduler run racing after hook startup is not shut down by busy prompt cleanup", async () => {
  const { hooks, agent } = createHooks({
    getSession: () => undefined,
    startSession: async () => {
      agent.alive = true;
      agent.running = true;
      return { agent, created: true };
    },
  });
  agent.alive = false;

  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /busy/);
  assert.equal(agent.alive, true);
  assert.equal(agent.sent.some((command) => command.type === "close_session"), false);
  assert.equal(agent.sent.some((command) => command.type === "abort" || command.type === "cancel_run"), false);
});

test("a reused concurrent startup is left to shared idle cleanup after prompt failure", async () => {
  const { hooks, agent } = createHooks({
    startSession: async () => {
      agent.alive = true;
      return { agent, created: false };
    },
  });
  agent.alive = false;
  agent.send = async function send(command) {
    this.sent.push(command);
    if (command.type === "get_state") return { runEpoch: 1 };
    if (command.type === "peer_prompt_and_wait") throw new Error("shared prompt failed");
    return null;
  };

  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /shared prompt failed/);
  assert.equal(agent.alive, true);
  assert.equal(agent.sent.some((command) => command.type === "close_session"), false);
});

test("a failed initial prompt closes only the wrapper started by this hook before compensation", async () => {
  const { hooks, agent } = createHooks();
  agent.alive = false;
  agent.send = async function send(command) {
    this.sent.push(command);
    if (command.type === "get_state") return { runEpoch: 1 };
    if (command.type === "peer_prompt_and_wait") throw new Error("initial prompt failed");
    return null;
  };

  await assert.rejects(() => hooks.promptPeerSession?.(peerRequest()), /initial prompt failed/);
  assert.equal(agent.alive, false);
  assert.equal(agent.sent.at(-1).type, "close_session");
});

test("cancellation carries the exact run id and epoch", async () => {
  let finish;
  const { hooks, agent } = createHooks();
  agent.send = async function send(command) {
    this.sent.push(command);
    if (command.type === "get_state") return { runEpoch: 8 };
    if (command.type === "peer_prompt_and_wait") return new Promise((resolve) => { finish = resolve; });
    return { cancelled: true };
  };
  const controller = new AbortController();
  const prompting = hooks.promptPeerSession?.(peerRequest({ runId: "cancel-me" }), controller.signal);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  controller.abort();
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  finish({ text: "aborted" });
  await assert.rejects(prompting, /aborted/);

  assert.deepEqual(agent.sent.find((command) => command.type === "cancel_run"), {
    type: "cancel_run",
    runId: "cancel-me",
    runEpoch: 9,
  });
});
