import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createWebSessionOrchestrationHost } = await jiti.import("./session-orchestration-host.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { createSessionOrchestrationOwnerCapability } = await import(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-orchestration-authority.js"
);

/** Build a minimal assistant message for persisted-host tests.
 * @author GPT-5.6 Sol
 */
function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "test",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class FakeRpcSession {
  alive = true;
  running = false;
  lastText = "";
  commands = [];

  /** Bind the fake wrapper to its persisted JSONL file.
   * @author GPT-5.6 Sol
   */
  constructor(sessionFile) {
    this.sessionFile = sessionFile;
  }

  /** Report wrapper liveness.
   * @author GPT-5.6 Sol
   */
  isAlive() {
    return this.alive;
  }

  /** Report whether a fake worker turn is active.
   * @author GPT-5.6 Sol
   */
  isRunning() {
    return this.running;
  }

  /** Execute the subset of RPC commands required by the Web host.
   * @author GPT-5.6 Sol
   */
  async send(command) {
    this.commands.push(command);
    if (command.type === "orchestrated_prompt") {
      if (this.running) throw new Error("busy");
      this.running = true;
      const manager = SessionManager.open(this.sessionFile);
      manager.appendMessage({ role: "user", content: command.message, timestamp: Date.now() });
      this.lastText = `reply-${manager.buildSessionContext().messages.filter((message) => message.role === "user").length}:${command.message}`;
      manager.appendMessage(assistantMessage(this.lastText));
      this.running = false;
      return { text: this.lastText };
    }
    if (command.type === "get_last_assistant_text") return { text: this.lastText };
    if (command.type === "abort") {
      this.running = false;
      return null;
    }
    return null;
  }
}

/** Create an isolated owner and dependency-backed Web host.
 * @author GPT-5.6 Sol
 */
async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-orchestration-"));
  const sessionDir = join(root, "sessions");
  const runtimes = new Map();
  const starts = [];
  const cached = [];
  let invalidations = 0;
  const host = createWebSessionOrchestrationHost({
    startSession: async (sessionId, sessionFile, cwd, toolNames) => {
      starts.push({ sessionId, sessionFile, cwd, toolNames });
      if (options.startDelayMs) {
        await new Promise((resolve) => {
          setTimeout(() => {
            // Cancel exactly as the delayed startup resolves so the test does
            // not depend on event-loop timing under parallel test load.
            options.onStartSession?.();
            resolve();
          }, options.startDelayMs);
        });
      }
      let runtime = runtimes.get(sessionId);
      if (!runtime) {
        runtime = new FakeRpcSession(sessionFile);
        runtimes.set(sessionId, runtime);
      }
      return runtime;
    },
    getSession: (sessionId) => runtimes.get(sessionId),
    cacheSessionPath: (sessionId, sessionFile) => cached.push({ sessionId, sessionFile }),
    invalidateSessionPath: () => {},
    invalidateSessionList: () => { invalidations += 1; },
  });
  const controller = SessionManager.create(root, sessionDir, { id: "controller-a" });
  controller.persistSession();
  const owner = {
    sessionId: "controller-a",
    sessionFile: controller.getSessionFile(),
    ownerCapability: createSessionOrchestrationOwnerCapability(controller),
    sessionDir,
    cwd: root,
    model: {
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages",
      provider: "test",
      baseUrl: "http://localhost:0",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    thinkingLevel: "high",
    projectTrusted: true,
  };
  return {
    root,
    host,
    owner,
    runtimes,
    starts,
    cached,
    get invalidations() { return invalidations; },
  };
}

test("passes: Web host creates a clean persisted session and routes repeated prompts to one RPC identity", async () => {
  const fixture = await createFixture();
  try {
    const worker = await fixture.host.createSession(fixture.owner, {
      name: "Independent validator",
      kind: "session",
      toolProfile: "read-only",
      model: { provider: "test", modelId: "test-model" },
      thinkingLevel: "high",
    });

    const first = await fixture.host.promptSession(fixture.owner, worker.sessionId, "review without prior conclusions");
    const second = await fixture.host.promptSession(fixture.owner, worker.sessionId, "validate edge cases");

    assert.match(first.response, /^reply-1:/);
    assert.match(second.response, /^reply-2:/);
    assert.equal(fixture.starts[0].sessionId, worker.sessionId);
    assert.deepEqual(fixture.starts[0].toolNames, ["read", "grep", "find", "ls"]);
    assert.equal(fixture.cached[0].sessionId, worker.sessionId);
    assert.ok(fixture.invalidations >= 3);

    const manager = SessionManager.open(fixture.starts[0].sessionFile);
    assert.equal(manager.getHeader().parentSession, undefined);
    assert.equal(manager.getHeader().orchestration.ownerSessionId, "controller-a");
    const users = manager.buildSessionContext().messages.filter((message) => message.role === "user");
    assert.deepEqual(users.map((message) => message.content), [
      "review without prior conclusions",
      "validate edge cases",
    ]);

    const promptCommands = fixture.runtimes.get(worker.sessionId).commands
      .filter((command) => command.type === "orchestrated_prompt");
    assert.equal(promptCommands[0].modelProvider, "test");
    assert.equal(promptCommands[0].modelId, "test-model");
    assert.equal(promptCommands[0].thinkingLevel, "high");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("passes: cancellation cleanup deletes only an empty persisted worker", async () => {
  const fixture = await createFixture();
  try {
    const empty = await fixture.host.createSession(fixture.owner, {
      name: "Cancelled empty worker",
      kind: "delegate",
      toolProfile: "read-only",
    });
    const emptyPath = fixture.cached.at(-1).sessionFile;
    assert.equal(await fixture.host.discardSessionIfEmpty(fixture.owner, empty.sessionId), true);
    assert.equal(existsSync(emptyPath), false);

    const retained = await fixture.host.createSession(fixture.owner, {
      name: "Started worker",
      kind: "delegate",
      toolProfile: "read-only",
    });
    const retainedPath = fixture.cached.at(-1).sessionFile;
    SessionManager.open(retainedPath).appendMessage({ role: "user", content: "started", timestamp: Date.now() });
    assert.equal(await fixture.host.discardSessionIfEmpty(fixture.owner, retained.sessionId), false);
    assert.equal(existsSync(retainedPath), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails safely: unrelated owners cannot prompt or inspect a worker", async () => {
  const fixture = await createFixture();
  try {
    const worker = await fixture.host.createSession(fixture.owner, {
      name: "Private worker",
      kind: "session",
      toolProfile: "none",
    });
    const unrelated = { ...fixture.owner, sessionId: "controller-b" };

    await assert.rejects(
      () => fixture.host.promptSession(unrelated, worker.sessionId, "steal context"),
      /not owned/,
    );
    await assert.rejects(
      () => fixture.host.getSessionStatus(unrelated, worker.sessionId),
      /not owned/,
    );
    assert.equal(fixture.starts.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails safely: cancellation during runtime startup never submits the worker prompt", async () => {
  const controller = new AbortController();
  const fixture = await createFixture({
    startDelayMs: 50,
    onStartSession: () => controller.abort(),
  });
  try {
    const worker = await fixture.host.createSession(fixture.owner, {
      name: "Cancelled worker",
      kind: "delegate",
      toolProfile: "none",
    });
    const pending = fixture.host.promptSession(
      fixture.owner,
      worker.sessionId,
      "must not run",
      controller.signal,
    );
    await assert.rejects(pending, /aborted/);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const commands = fixture.runtimes.get(worker.sessionId).commands;
    assert.equal(commands.some((command) => command.type === "orchestrated_prompt"), false);
    assert.equal(commands.some((command) => command.type === "abort"), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fails safely: a busy worker rejects another prompt and can be aborted", async () => {
  const fixture = await createFixture();
  try {
    const worker = await fixture.host.createSession(fixture.owner, {
      name: "Busy worker",
      kind: "delegate",
      toolProfile: "read-only",
    });
    await fixture.host.promptSession(fixture.owner, worker.sessionId, "initialize");
    const runtime = fixture.runtimes.get(worker.sessionId);
    runtime.running = true;

    await assert.rejects(
      () => fixture.host.promptSession(fixture.owner, worker.sessionId, "overlap"),
      /busy/,
    );
    assert.equal(await fixture.host.abortSession(fixture.owner, worker.sessionId), true);
    assert.equal(runtime.running, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
