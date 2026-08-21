import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareTestRuntime, TEST_WEB_PORT } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(webRoot, "..");
const testAgentDir = join(workspaceRoot, ".pi-session-orchestration-e2e");
const testCwd = join(workspaceRoot, ".pi-session-orchestration-workspace");
const baseUrl = `http://127.0.0.1:${TEST_WEB_PORT}`;
const maxWaitMs = 120_000;
let toolCallCounter = 0;
let activeDelegates = 0;
let maxActiveDelegates = 0;
let serverOutput = "";

/** Convert an OpenAI-compatible message body to plain text.
 * @author GPT-5.6 Sol
 */
function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part === "string" ? part : (part?.text ?? "")).join("\n");
}

/** Return the latest user message from an OpenAI-compatible request.
 * @author GPT-5.6 Sol
 */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

/** Join the consecutive tool results at the end of one model request.
 * @author GPT-5.6 Sol
 */
function trailingToolText(messages) {
  const result = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "tool") break;
    result.unshift(messageText(messages[index]));
  }
  return result.join("\n");
}

/** Recover the worker ID that the parent model previously reported.
 * @author GPT-5.6 Sol
 */
function findWorkerId(messages) {
  const text = messages.map(messageText).join("\n");
  const match = text.match(/CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/);
  if (!match) throw new Error("The fake parent model could not recover its worker Session ID");
  return match[1];
}

/** Build one OpenAI Chat Completions streaming chunk.
 * @author GPT-5.6 Sol
 */
function chunk(delta, finishReason = null, usage) {
  return {
    id: `chatcmpl-orchestration-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "orchestration-fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** Write one JSON Server-Sent Event.
 * @author GPT-5.6 Sol
 */
function writeEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

/** Complete one fake text response.
 * @author GPT-5.6 Sol
 */
function sendText(response, text) {
  writeEvent(response, chunk({ role: "assistant", content: text }));
  writeEvent(response, chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 5 }));
  response.end("data: [DONE]\n\n");
}

/** Complete one fake response containing one or more tool calls.
 * @author GPT-5.6 Sol
 */
function sendToolCalls(response, calls) {
  writeEvent(response, chunk({
    role: "assistant",
    tool_calls: calls.map((call, index) => ({
      index,
      id: `orchestration-tool-${++toolCallCounter}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })),
  }));
  writeEvent(response, chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5 }));
  response.end("data: [DONE]\n\n");
}

/** Deterministically emulate parent, worker, and delegate model turns.
 * @author GPT-5.6 Sol
 */
async function handleModelRequest(body, response) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages.at(-1);
  const userText = latestUserText(messages);
  const toolText = trailingToolText(messages);

  if (lastMessage?.role === "tool") {
    if (/not owned by this session/i.test(toolText)) return sendText(response, "OWNERSHIP_REJECTED");
    if (/Created [A-Za-z0-9._-]+/.test(toolText) && /WORKER_REPLY_1/.test(toolText)) {
      const workerId = toolText.match(/Created ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `CREATED:${workerId}`);
    }
    if (/Created clean persisted session/.test(toolText)) {
      const workerId = toolText.match(/session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `IDLE_CREATED:${workerId}`);
    }
    if (/WORKER_REPLY_2/.test(toolText)) return sendText(response, "CONTINUED");
    if (/WORKER_SLOW_REPLY/.test(toolText)) return sendText(response, "SLOW_COMPLETED");
    if (/delegate-one-result/.test(toolText) && /delegate-two-result/.test(toolText)) {
      return sendText(response, "DELEGATES_AGGREGATED");
    }
    return sendText(response, `UNEXPECTED_TOOL_RESULT:${toolText.slice(0, 200)}`);
  }

  if (userText === "E2E_CREATE") {
    return sendToolCalls(response, [{
      name: "session_create",
      arguments: {
        name: "E2E independent validator",
        tool_profile: "none",
        initial_prompt: "WORKER_FIRST",
      },
    }]);
  }
  if (userText === "E2E_CREATE_IDLE") {
    return sendToolCalls(response, [{
      name: "session_create",
      arguments: { name: "E2E remotely leased worker", tool_profile: "none" },
    }]);
  }
  if (userText === "E2E_CONTINUE") {
    return sendToolCalls(response, [{
      name: "session_prompt",
      arguments: { session_id: findWorkerId(messages), prompt: "WORKER_SECOND" },
    }]);
  }
  if (userText === "E2E_SLOW_WORKER") {
    return sendToolCalls(response, [{
      name: "session_prompt",
      arguments: { session_id: findWorkerId(messages), prompt: "WORKER_SLOW" },
    }]);
  }
  if (userText === "E2E_DELEGATE") {
    return sendToolCalls(response, [{
      name: "session_delegate",
      arguments: {
        tasks: [
          { name: "delegate-one", prompt: "DELEGATE_ONE", tool_profile: "none" },
          { name: "delegate-two", prompt: "DELEGATE_TWO", tool_profile: "none" },
        ],
      },
    }]);
  }
  if (userText.startsWith("E2E_STEAL:")) {
    return sendToolCalls(response, [{
      name: "session_prompt",
      arguments: { session_id: userText.slice("E2E_STEAL:".length), prompt: "UNAUTHORIZED" },
    }]);
  }
  if (userText === "WORKER_FIRST") return sendText(response, "WORKER_REPLY_1");
  if (userText === "WORKER_SECOND") return sendText(response, "WORKER_REPLY_2");
  if (userText === "WORKER_SLOW") {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    return sendText(response, "WORKER_SLOW_REPLY");
  }
  if (userText === "DELEGATE_ONE" || userText === "DELEGATE_TWO") {
    activeDelegates += 1;
    maxActiveDelegates = Math.max(maxActiveDelegates, activeDelegates);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    activeDelegates -= 1;
    return sendText(response, userText === "DELEGATE_ONE" ? "delegate-one-result" : "delegate-two-result");
  }
  return sendText(response, `ECHO:${userText}`);
}

/** Refuse to interfere with another process already using the isolated test port.
 * @author GPT-5.6 Sol
 */
async function assertTestPortAvailable() {
  const probe = createServer();
  try {
    probe.listen(Number(TEST_WEB_PORT), "127.0.0.1");
    await once(probe, "listening");
  } catch (error) {
    throw new Error(`Refusing to use occupied Pi-Web test port ${TEST_WEB_PORT}`, { cause: error });
  } finally {
    if (probe.listening) await new Promise((resolveClose) => probe.close(() => resolveClose()));
  }

  // A dev server bound only to IPv6 (`::`) would pass the IPv4 probe above.
  // Detect any live HTTP service as well so we never hijack a user's session.
  try {
    const response = await fetch(`${baseUrl}/api/runtime`, { signal: AbortSignal.timeout(3_000) });
    if (response.ok) {
      throw new Error(`Refusing to use Pi-Web test port ${TEST_WEB_PORT}: a live server is already responding`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    // Connection refused/timeout: no live server, port is truly free.
  }
}

/** Start a local OpenAI-compatible fake provider on an ephemeral port.
 * @author GPT-5.6 Sol
 */
async function startModelServer() {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "orchestration-fake-model", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }

    let rawBody = "";
    for await (const bodyChunk of request) rawBody += bodyChunk.toString();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    await handleModelRequest(JSON.parse(rawBody), response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake model server has no TCP address");
  return { server, port: address.port };
}

/** Write a fake provider configuration into the isolated agent directory.
 * @author GPT-5.6 Sol
 */
async function writeTestConfiguration(modelPort) {
  await writeFile(join(testAgentDir, "models.json"), JSON.stringify({
    providers: {
      "orchestration-fake": {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: "openai-completions",
        apiKey: "e2e-only",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{
          id: "orchestration-fake-model",
          name: "Orchestration Fake",
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2));
  await writeFile(join(testAgentDir, "settings.json"), JSON.stringify({
    defaultProvider: "orchestration-fake",
    defaultModel: "orchestration-fake-model",
    defaultThinkingLevel: "off",
  }, null, 2));
}

/** Fetch JSON and convert non-success responses into useful failures.
 * @author GPT-5.6 Sol
 */
async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${path}: ${body.error ?? response.status}`);
  return body;
}

/** Wait until the isolated Next.js server reports matching local Pi Agent code.
 * @author GPT-5.6 Sol
 */
async function waitForWeb() {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/runtime`);
      if (response.ok) return response.json();
    } catch {
      // The development server is still compiling.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`Pi-Web did not start.\n${serverOutput.slice(-8000)}`);
}

/** Read the latest assistant text through the normal RPC route.
 * @author GPT-5.6 Sol
 */
async function getLastText(sessionId) {
  const result = await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "get_last_assistant_text" }),
  });
  return result.data?.text ?? "";
}

/** Wait for a newly submitted turn to settle and produce a different final answer.
 * @author GPT-5.6 Sol
 */
async function waitForTurn(sessionId, previousText) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const state = await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`);
    if (state.running && state.state) {
      const busy = Boolean(state.state.isPromptRunning || state.state.isStreaming || state.state.isCompacting);
      if (!busy && (await getLastText(sessionId)) !== previousText) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Session ${sessionId} did not settle.\n${serverOutput.slice(-8000)}`);
}

/** Submit one parent turn and return its final text.
 * @author GPT-5.6 Sol
 */
async function promptSession(sessionId, message) {
  const previousText = await getLastText(sessionId);
  await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message }),
  });
  await waitForTurn(sessionId, previousText);
  return getLastText(sessionId);
}

/** Create one controller through the public new-agent route.
 * @author GPT-5.6 Sol
 */
async function createController(message) {
  const result = await requestJson("/api/agent/new", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: testCwd,
      type: "prompt",
      message,
      provider: "orchestration-fake",
      modelId: "orchestration-fake-model",
      thinkingLevel: "off",
      toolNames: ["read", "bash", "edit", "write"],
    }),
  });
  await waitForTurn(result.sessionId, "");
  return result.sessionId;
}

/** Extract stored user text from a Pi-Web session response.
 * @author GPT-5.6 Sol
 */
function userTexts(context) {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
}

/** Terminate only the isolated Next.js process tree started by this test.
 * @author GPT-5.6 Sol
 */
function stopWebProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/** Wait for a child-process readiness marker or fail with its captured stderr.
 * @author GPT-5.6 Sol
 */
async function waitForChildOutput(child, marker) {
  let output = "";
  child.stdout?.on("data", (data) => { output += data.toString(); });
  child.stderr?.on("data", (data) => { output += data.toString(); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (output.includes(marker)) return;
    if (child.exitCode !== null) throw new Error(`Child exited before ${marker}: ${output}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for ${marker}: ${output}`);
}

/** Execute the full controller/worker/delegate lifecycle without a paid model.
 * @author GPT-5.6 Sol
 */
async function main() {
  await assertTestPortAvailable();
  await Promise.all([
    rm(testAgentDir, { recursive: true, force: true }),
    rm(testCwd, { recursive: true, force: true }),
  ]);
  await Promise.all([mkdir(testAgentDir, { recursive: true }), mkdir(testCwd, { recursive: true })]);

  const model = await startModelServer();
  let webProcess;
  let leaseProcess;
  try {
    await writeTestConfiguration(model.port);
    const runtime = await prepareTestRuntime({ testAgentDir });
    const nextBin = require.resolve("next/dist/bin/next");
    webProcess = spawn(process.execPath, [nextBin, "dev", "-p", TEST_WEB_PORT], {
      cwd: webRoot,
      env: { ...runtime.environment, NO_PROXY: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    webProcess.stdout.on("data", (data) => { serverOutput += data.toString(); });
    webProcess.stderr.on("data", (data) => { serverOutput += data.toString(); });

    const runtimeInfo = await waitForWeb();
    assert.equal(runtimeInfo.piAgent?.sourceMatches, true);
    assert.equal(resolve(runtimeInfo.piAgent?.dataDir), resolve(testAgentDir));

    const controllerId = await createController("E2E_CREATE");
    const createdText = await getLastText(controllerId);
    const workerId = createdText.match(/CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    assert.ok(workerId, createdText);
    assert.equal(await promptSession(controllerId, "E2E_CONTINUE"), "CONTINUED");

    const worker = await requestJson(`/api/sessions/${workerId}`);
    assert.deepEqual(userTexts(worker.context), ["WORKER_FIRST", "WORKER_SECOND"]);
    assert.equal(worker.info.parentSessionId, undefined);
    assert.equal(worker.info.orchestration.ownerSessionId, controllerId);
    const controllerDelete = await fetch(`${baseUrl}/api/sessions/${controllerId}`, { method: "DELETE" });
    assert.equal(controllerDelete.status, 409);
    assert.match((await controllerDelete.json()).error, /owned worker Sessions/);

    await assert.rejects(
      () => requestJson(`/api/agent/${workerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "get_last_assistant_text" }),
      }),
      /owning controller/,
    );
    // Live worker is observable read-only through state and SSE.
    const liveState = await requestJson(`/api/sessions/${workerId}/state`);
    assert.equal(liveState.running, true);
    assert.equal(liveState.state.sessionId, workerId);
    const liveEvents = await fetch(`${baseUrl}/api/agent/${workerId}/events`);
    assert.equal(liveEvents.status, 200);
    liveEvents.body?.cancel();
    await assert.rejects(
      () => requestJson(`/api/sessions/${workerId}/auto-name`, { method: "POST" }),
      /owning controller/,
    );

    await assert.rejects(
      () => requestJson(`/api/agent/${workerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "set_tools", toolNames: ["read", "bash", "edit", "write"] }),
      }),
      /owning controller/,
    );
    await assert.rejects(
      () => requestJson(`/api/agent/${workerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "bash", command: "echo unsafe" }),
      }),
      /owning controller/,
    );

    await assert.rejects(
      () => requestJson(`/api/agent/${workerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: "UNAUTHORIZED_GENERIC_PROMPT" }),
      }),
      /owning controller/,
    );
    await assert.rejects(
      () => requestJson("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intervalSeconds: 60, prompt: "UNAUTHORIZED_SCHEDULE", sessionId: workerId }),
      }),
      /cannot own schedules/,
    );

    const previousControllerText = await getLastText(controllerId);
    await requestJson(`/api/agent/${controllerId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "E2E_SLOW_WORKER" }),
    });
    const runningDeadline = Date.now() + maxWaitMs;
    let workerRunning = false;
    while (Date.now() < runningDeadline) {
      const state = await requestJson("/api/sessions");
      workerRunning = state.runningSessionIds.includes(workerId);
      if (workerRunning) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal(workerRunning, true, "worker never entered its slow running state");
    const deleteResponse = await fetch(`${baseUrl}/api/sessions/${workerId}`, { method: "DELETE" });
    assert.equal(deleteResponse.status, 403);
    assert.match((await deleteResponse.json()).error, /owning controller/);
    await waitForTurn(controllerId, previousControllerText);
    assert.equal(await getLastText(controllerId), "SLOW_COMPLETED");
    await requestJson(`/api/sessions/${workerId}`);

    const leaseProbe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import { acquireOrchestratedSessionDeletionLease, SessionManager } from "@earendil-works/pi-coding-agent";
       try {
         const lease = await acquireOrchestratedSessionDeletionLease(SessionManager.open(process.argv[1]));
         await lease.release();
         process.exit(2);
       } catch (error) {
         if (!String(error).includes("another process")) { console.error(error); process.exit(3); }
       }`,
      worker.info.path,
    ], { cwd: webRoot, encoding: "utf8" });
    assert.equal(leaseProbe.status, 0, leaseProbe.stderr || leaseProbe.stdout);

    const idleCreatedText = await promptSession(controllerId, "E2E_CREATE_IDLE");
    const idleWorkerId = idleCreatedText.match(/IDLE_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    assert.ok(idleWorkerId, idleCreatedText);
    const idleWorker = await requestJson(`/api/sessions/${idleWorkerId}`);
    await assert.rejects(
      () => requestJson(`/api/agent/${idleWorkerId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "get_state" }),
      }),
      /owning controller/,
    );
    const idleEvents = await fetch(`${baseUrl}/api/agent/${idleWorkerId}/events`);
    assert.equal(idleEvents.status, 403);
    await assert.rejects(
      () => requestJson(`/api/sessions/${idleWorkerId}/auto-name`, { method: "POST" }),
      /owning controller/,
    );
    await assert.rejects(
      () => requestJson(`/api/sessions/${idleWorkerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Unauthorized rename" }),
      }),
      /owning controller/,
    );
    leaseProcess = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import { acquireOrchestratedSessionDeletionLease, SessionManager } from "@earendil-works/pi-coding-agent";
       const lease = await acquireOrchestratedSessionDeletionLease(SessionManager.open(process.argv[1]));
       console.log("LEASE_READY");
       process.on("SIGTERM", async () => { await lease.release(); process.exit(0); });
       setInterval(() => {}, 1000);`,
      idleWorker.info.path,
    ], { cwd: webRoot, stdio: ["ignore", "pipe", "pipe"] });
    await waitForChildOutput(leaseProcess, "LEASE_READY");
    const remoteDelete = await fetch(`${baseUrl}/api/sessions/${idleWorkerId}`, { method: "DELETE" });
    assert.equal(remoteDelete.status, 403);
    assert.match((await remoteDelete.json()).error, /owning controller/);
    stopWebProcess(leaseProcess);
    leaseProcess = undefined;

    assert.equal(await promptSession(controllerId, "E2E_DELEGATE"), "DELEGATES_AGGREGATED");
    assert.equal(maxActiveDelegates, 2);
    const sessionList = await requestJson("/api/sessions");
    const delegates = sessionList.sessions.filter(
      (session) => session.orchestration?.ownerSessionId === controllerId
        && session.orchestration.kind === "delegate",
    );
    assert.equal(delegates.length, 2);

    const unrelatedId = await createController(`E2E_STEAL:${workerId}`);
    assert.equal(await getLastText(unrelatedId), "OWNERSHIP_REJECTED");

    const tools = await requestJson(`/api/agent/${controllerId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get_tools" }),
    });
    const activeTools = new Set(tools.data.filter((tool) => tool.active).map((tool) => tool.name));
    for (const toolName of ["session_create", "session_prompt", "session_status", "session_abort", "session_delegate"]) {
      assert.ok(activeTools.has(toolName), `${toolName} is not active`);
    }

    console.log(`Session orchestration E2E passed: controller=${controllerId}, worker=${workerId}, delegates=${delegates.length}`);
  } finally {
    stopWebProcess(leaseProcess);
    stopWebProcess(webProcess);
    model.server.closeAllConnections?.();
    await new Promise((resolveClose) => model.server.close(() => resolveClose()));
    await Promise.all([
      rm(testAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      rm(testCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
    ]);
  }
}

await main();
