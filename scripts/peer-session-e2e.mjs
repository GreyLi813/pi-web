import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareTestRuntime, TEST_WEB_PORT } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(webRoot, "..");
const testAgentDir = join(workspaceRoot, ".pi-peer-session-e2e");
const testCwd = join(workspaceRoot, ".pi-peer-session-workspace");
const baseUrl = `http://127.0.0.1:${TEST_WEB_PORT}`;
const maxWaitMs = 120_000;
let serverOutput = "";

/** Convert an OpenAI-compatible message body to plain text.
 * @author Kimi K3
 */
function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part === "string" ? part : (part?.text ?? "")).join("\n");
}

/** Return the latest user message from an OpenAI-compatible request.
 * @author Kimi K3
 */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

/** Return the concatenated text of trailing tool results.
 * @author Kimi K3
 */
function trailingToolText(messages) {
  const parts = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "tool") break;
    parts.unshift(messageText(messages[index]));
  }
  return parts.join("\n");
}

/** Write one SSE chunk of an OpenAI-compatible streaming response.
 * @author Kimi K3
 */
function writeEvent(response, data) {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Emit a complete text reply as an OpenAI-compatible stream.
 * @author Kimi K3
 */
function sendText(response, text) {
  const chunk = (delta) => ({
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
  });
  writeEvent(response, chunk({ content: text }));
  writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  writeEvent(response, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  response.end("data: [DONE]\n\n");
}

/** Emit one assistant turn containing tool calls as an OpenAI-compatible stream.
 * @author Kimi K3
 */
let toolCallCounter = 0;
function sendToolCalls(response, calls) {
  calls.forEach((call, index) => {
    writeEvent(response, {
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index,
            id: `peer-tool-${++toolCallCounter}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: null,
      }],
    });
  });
  writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  writeEvent(response, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  response.end("data: [DONE]\n\n");
}

/** Deterministically emulate controller and peer model turns.
 * @author Kimi K3
 */
async function handleModelRequest(body, response) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastMessage = messages.at(-1);
  const userText = latestUserText(messages);
  const toolText = trailingToolText(messages);

  if (lastMessage?.role === "tool") {
    if (/Created authorized peer Session/.test(toolText)) {
      const peerId = toolText.match(/peer Session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `PEER_CREATED:${peerId}`);
    }
    if (/PEER_SECOND_PONG/.test(toolText)) return sendText(response, "PEER_PROMPTED");
    return sendText(response, `UNEXPECTED_TOOL_RESULT:${toolText.slice(0, 200)}`);
  }

  if (userText === "E2E_CREATE_PEER") {
    return sendToolCalls(response, [{
      name: "peer_session_create",
      arguments: {
        name: "E2E peer agent",
        provider: "orchestration-fake",
        model_id: "orchestration-fake-model-2",
        thinking_level: "off",
        initial_prompt: "PEER_FIRST_PING",
        schedules: [{ interval: "10s", prompt: "PEER_SCHEDULED_PING" }],
      },
    }]);
  }
  if (userText === "E2E_PROMPT_PEER") {
    return sendToolCalls(response, [{
      name: "peer_session_prompt",
      arguments: { session_id: findPeerId(messages), prompt: "PEER_SECOND_PING" },
    }]);
  }
  if (userText === "PEER_FIRST_PING") return sendText(response, "PEER_FIRST_PONG");
  if (userText === "PEER_SECOND_PING") return sendText(response, "PEER_SECOND_PONG");
  if (userText === "PEER_SCHEDULED_PING") return sendText(response, "PEER_PONG");
  return sendText(response, `ECHO:${userText}`);
}

/** Extract the peer session id from a controller conversation.
 * @author Kimi K3
 */
function findPeerId(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "tool") continue;
    const match = messageText(messages[index]).match(/peer Session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/);
    if (match) return match[1];
  }
  return "missing-peer";
}

/** Refuse to interfere with another process already using the isolated test port.
 * @author Kimi K3
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
 * @author Kimi K3
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
 * @author Kimi K3
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
        }, {
          id: "orchestration-fake-model-2",
          name: "Orchestration Fake 2",
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
 * @author Kimi K3
 */
async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${path}: ${body.error ?? response.status}`);
  return body;
}

/** Wait until the isolated Next.js server reports matching local Pi Agent code.
 * @author Kimi K3
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
 * @author Kimi K3
 */
async function getLastText(sessionId) {
  const result = await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "get_last_assistant_text" }),
  });
  return result.data?.text ?? "";
}

/** Read the latest assistant text from the read-only persisted Session route.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function getPersistedLastText(sessionId) {
  const session = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const assistant = [...session.context.messages].reverse().find((message) => message.role === "assistant");
  if (!assistant) return "";
  return typeof assistant.content === "string"
    ? assistant.content
    : assistant.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

/** Wait for one owner/scheduler peer turn through read-only history.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function waitForPersistedTurn(sessionId, previousText) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const current = await getPersistedLastText(sessionId);
    if (current && current !== previousText) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  const scheduleState = await fetch(`${baseUrl}/api/schedules`).then((response) => response.text()).catch(() => "unavailable");
  const schedulerLogs = serverOutput.split("\n").filter((line) => /scheduler|schedule authorization|scheduled prompt/i.test(line)).slice(-80).join("\n");
  throw new Error(`Session ${sessionId} did not persist a new turn.\nSchedules: ${scheduleState}\n${schedulerLogs}`);
}

/** Wait for a newly submitted turn to settle and produce a different final answer.
 * @author Kimi K3
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

/** Submit one controller turn and return its final text.
 * @author Kimi K3
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
 * @author Kimi K3
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

/** Read one persisted session JSONL file as parsed entries.
 * @author Kimi K3
 */
async function readSessionEntries(path) {
  const raw = await readFile(path, "utf-8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Terminate only the isolated Next.js process tree started by this test.
 * @author Kimi K3
 */
function stopWebProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/** Execute the same-level session, model pinning, and schedule lifecycle without a paid model.
 * @author Kimi K3
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

    // Same-level session creation with pinned model, Thinking level, initial prompt, and a schedule.
    const controllerId = await createController("E2E_CREATE_PEER");
    const createdText = await getLastText(controllerId);
    const peerId = createdText.match(/PEER_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    assert.ok(peerId, createdText);
    assert.notEqual(peerId, controllerId);

    // The creation-time initial prompt already ran inside the peer.
    assert.equal(await getPersistedLastText(peerId), "PEER_FIRST_PONG");

    // The UI's session-page state probes succeed for a live idle peer.
    const peerStateProbe = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(peerId)}/state`);
    assert.equal(peerStateProbe.status, 200, `state probe: ${await peerStateProbe.text()}`);
    const peerMessagesProbe = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`,
    );
    assert.equal(peerMessagesProbe.status, 200, `messages probe: ${await peerMessagesProbe.text()}`);

    // The peer is a top-level session: no orchestration metadata, visible in the list.
    const peer = await requestJson(`/api/sessions/${peerId}`);
    assert.equal(peer.info.orchestration, undefined);
    const sessionList = await requestJson("/api/sessions");
    assert.ok(sessionList.sessions.some((session) => session.id === peerId), "peer missing from session list");

    // Model and Thinking level are persisted inside the peer's own session file.
    const entries = await readSessionEntries(peer.info.path);
    const header = entries.find((entry) => entry.type === "session");
    assert.equal(header.orchestration, undefined);
    assert.ok(entries.some((entry) => entry.type === "model_change"
      && entry.provider === "orchestration-fake"
      && entry.modelId === "orchestration-fake-model-2"));
    assert.ok(entries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "off"));
    assert.equal(header.peer?.version, 3);
    assert.match(header.peer?.authorityId ?? "", /^peer-authority-/);
    assert.match(header.peer?.runtimePolicyHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(header.peer?.ownerFileKey ?? "", /.+/);
    assert.match(header.peer?.runtime.endpointFingerprint ?? "", /^[a-f0-9]{64}$/);

    // The live peer wrapper runs only the durable model/Thinking/tool policy.
    const peerState = await requestJson(`/api/agent/${encodeURIComponent(peerId)}`);
    assert.equal(peerState.state.model?.id, "orchestration-fake-model-2");
    assert.equal(peerState.state.thinkingLevel, "off");
    assert.deepEqual([...peerState.state.activeToolNames].sort(), [...header.peer.runtime.toolNames].sort());

    // Generic HTTP cannot close, prompt, or otherwise mutate another owner's peer.
    for (const command of [
      { type: "close_session" },
      { type: "prompt", message: "PEER_MANUAL" },
      { type: "set_tools", toolNames: ["bash", "write"] },
    ]) {
      const response = await fetch(`${baseUrl}/api/agent/${encodeURIComponent(peerId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      assert.equal(response.status, 403, `${command.type}: ${await response.text()}`);
    }

    // The schedule is bound to the peer in the shared persistent store.
    const schedulesBefore = await requestJson("/api/schedules");
    const bound = schedulesBefore.schedules.find((schedule) => schedule.sessionId === peerId);
    assert.ok(bound, "no schedule bound to the peer session");
    assert.equal(bound.prompt, "PEER_SCHEDULED_PING");
    assert.equal(bound.intervalSeconds, 10);
    assert.equal(bound.enabled, true);

    const genericPause = await fetch(`${baseUrl}/api/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pause", id: bound.id }),
    });
    assert.equal(genericPause.status, 403, await genericPause.text());

    // The controller remains the safe prompt path through peer_session_prompt.
    assert.equal(await promptSession(controllerId, "E2E_PROMPT_PEER"), "PEER_PROMPTED");
    assert.equal(await getPersistedLastText(peerId), "PEER_SECOND_PONG");

    // No browser ticker or dispatch API call is made: the Node lifecycle scheduler fires it.
    await waitForPersistedTurn(peerId, "PEER_SECOND_PONG");
    assert.equal(await getPersistedLastText(peerId), "PEER_PONG");
    const schedulesAfter = await requestJson("/api/schedules");
    assert.equal(schedulesAfter.schedules.find((schedule) => schedule.id === bound.id)?.fireCount, 1);

    // The peer session log contains only owner-authorized and scheduled prompts.
    const peerAfter = await requestJson(`/api/sessions/${peerId}`);
    const peerUserTexts = peerAfter.context.messages
      .filter((message) => message.role === "user")
      .map((message) => typeof message.content === "string"
        ? message.content
        : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
    assert.deepEqual(peerUserTexts, ["PEER_FIRST_PING", "PEER_SECOND_PING", "PEER_SCHEDULED_PING"]);

    const genericRename = await fetch(`${baseUrl}/api/sessions/${peerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "unauthorized rename" }),
    });
    assert.equal(genericRename.status, 403, await genericRename.text());
    const genericAutoName = await fetch(`${baseUrl}/api/sessions/${peerId}/auto-name`, { method: "POST" });
    assert.equal(genericAutoName.status, 403, await genericAutoName.text());
    const peerDelete = await fetch(`${baseUrl}/api/sessions/${peerId}`, { method: "DELETE" });
    assert.equal(peerDelete.status, 403, await peerDelete.text());
    assert.equal((await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(peerId)}`)).status, 200);

    console.log(`Peer session E2E passed: controller=${controllerId}, peer=${peerId}, schedule=${bound.id}`);
  } finally {
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
