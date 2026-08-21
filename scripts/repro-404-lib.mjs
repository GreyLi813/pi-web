// Shared helpers for repro-404-*.mjs scenario scripts.
// Test port 30142 only; isolated agent dirs under the workspace root only.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareTestRuntime, TEST_WEB_PORT } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);
export const webRoot = resolve(import.meta.dirname, "..");
export const workspaceRoot = resolve(webRoot, "..");
export const baseUrl = `http://127.0.0.1:${TEST_WEB_PORT}`;
export const maxWaitMs = 120_000;
export const toolCallCounter = { value: 0 };

/** Convert an OpenAI-compatible message body to plain text. */
export function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => typeof part === "string" ? part : (part?.text ?? "")).join("\n");
}

/** Return the latest user message from an OpenAI-compatible request. */
export function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

/** Return the concatenated text of trailing tool results. */
export function trailingToolText(messages) {
  const parts = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "tool") break;
    parts.unshift(messageText(messages[index]));
  }
  return parts.join("\n");
}

/** Write one SSE chunk of an OpenAI-compatible streaming response. */
export function writeEvent(response, data) {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Emit a complete text reply as an OpenAI-compatible stream. */
export function sendText(response, text) {
  const chunk = (delta) => ({
    choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
  });
  writeEvent(response, chunk({ content: text }));
  writeEvent(response, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  writeEvent(response, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  response.end("data: [DONE]\n\n");
}

/** Emit one assistant turn containing tool calls as an OpenAI-compatible stream. */
export function sendToolCalls(response, calls) {
  calls.forEach((call, index) => {
    writeEvent(response, {
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index,
            id: `repro-tool-${++toolCallCounter.value}`,
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

/** Refuse to interfere with another process already using the isolated test port. */
export async function assertTestPortAvailable() {
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
 * @param {Function} handleModel async (body, response) => void  — the fake model brain.
 */
export async function startModelServer(handleModel) {
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
    await handleModel(JSON.parse(rawBody), response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake model server has no TCP address");
  return { server, port: address.port };
}

/** Write a fake provider configuration into the isolated agent directory. */
export async function writeTestConfiguration(agentDir, modelPort) {
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "orchestration-fake": {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: "openai-completions",
        apiKey: "repro-only",
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
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "orchestration-fake",
    defaultModel: "orchestration-fake-model",
    defaultThinkingLevel: "off",
  }, null, 2));
}

/** Fetch JSON and convert non-success responses into useful failures. */
export async function requestJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(`${path}: ${body.error ?? response.status}`);
  return body;
}

/** Fetch a path and return { status, body } without throwing. */
export async function probe(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, body, text };
}

/** Wait until the isolated Next.js server reports matching local Pi Agent code. */
export async function waitForWeb(serverOutput) {
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

/** Read the latest assistant text through the normal RPC route. */
export async function getLastText(sessionId) {
  const result = await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "get_last_assistant_text" }),
  });
  return result.data?.text ?? "";
}

/** Wait for a newly submitted turn to settle and produce a different final answer. */
export async function waitForTurn(sessionId, previousText, serverOutput) {
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

/** Submit one controller turn and return its final text. */
export async function promptSession(sessionId, message, serverOutput) {
  const previousText = await getLastText(sessionId);
  await requestJson(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message }),
  });
  await waitForTurn(sessionId, previousText, serverOutput);
  return getLastText(sessionId);
}

/** Create one controller through the public new-agent route. */
export async function createController(message, testCwd, serverOutput) {
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
  await waitForTurn(result.sessionId, "", serverOutput);
  return result.sessionId;
}

/** Start the dev server on port 30142 with the isolated agent dir. */
export async function startWeb(agentDir, serverOutput) {
  const runtime = await prepareTestRuntime({ testAgentDir: agentDir });
  const nextBin = require.resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", TEST_WEB_PORT], {
    cwd: webRoot,
    env: { ...runtime.environment, NO_PROXY: "127.0.0.1,localhost" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => { serverOutput.value += data.toString(); });
  child.stderr.on("data", (data) => { serverOutput.value += data.toString(); });
  const runtimeInfo = await waitForWeb(serverOutput.value);
  return { child, runtimeInfo };
}

/** Terminate only the isolated Next.js process tree started by this test. */
export function stopWebProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

/** Read one persisted session JSONL file as parsed entries. */
export async function readSessionEntries(path) {
  const raw = await readFile(path, "utf-8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/** Poll the session list until a session matching the predicate appears. */
export async function waitForSessionInList(predicate, serverOutput, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await requestJson("/api/sessions");
    const match = list.sessions.find(predicate);
    if (match) return match;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Session never appeared in /api/sessions.\n${serverOutput.value.slice(-8000)}`);
}

/** Generate a plausible session id (uuidv7-like). */
export function randomSessionId() {
  return `019${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 6)}-7${Math.random().toString(16).slice(2, 5)}-9${Math.random().toString(16).slice(2, 5)}-${Math.random().toString(16).slice(2, 14)}`;
}

/** Clean up dirs and the fake provider. */
export async function cleanup(model, webProcess, ...dirs) {
  stopWebProcess(webProcess);
  model?.server.closeAllConnections?.();
  await new Promise((resolveClose) => model?.server.close(() => resolveClose()));
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
}
