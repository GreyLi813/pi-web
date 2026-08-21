// Scenario E: an orchestrated worker (child) session page.
// /api/sessions/<workerId>/state has an orchestration branch: a worker whose file
// exists NEVER 404s — idle returns 200 {running:false}, live returns 200 {running:true}.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTestPortAvailable, cleanup, createController, getLastText, probe,
  requestJson, sendText, sendToolCalls, startModelServer, startWeb,
  latestUserText, trailingToolText, waitForSessionInList, waitForTurn,
  writeTestConfiguration, workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-worker-page");
const testCwd = join(workspaceRoot, ".repro-workspace-worker-page");
const serverOutput = { value: "" };
const slow = { active: false };

async function main() {
  await assertTestPortAvailable();
  await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(testCwd, { recursive: true, force: true })]);
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(testCwd, { recursive: true })]);

  const model = await startModelServer(async (body, response) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = latestUserText(messages);
    const toolText = trailingToolText(messages);
    if (messages.at(-1)?.role === "tool") {
      const workerId = toolText.match(/Created ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `WORKER_CREATED:${workerId}`);
    }
    if (userText === "E2E_CREATE_WORKER") {
      return sendToolCalls(response, [{
        name: "session_create",
        arguments: { name: "E repro worker", tool_profile: "none", initial_prompt: "WORKER_FIRST" },
      }]);
    }
    if (userText === "WORKER_FIRST") {
      slow.active = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000)); // hold the initial worker turn open
      slow.active = false;
      return sendText(response, "WORKER_REPLY_1");
    }
    return sendText(response, `ECHO:${userText}`);
  });

  let webProcess;
  try {
    await writeTestConfiguration(agentDir, model.port);
    ({ child: webProcess } = await startWeb(agentDir, serverOutput));

    // Start the controller turn WITHOUT awaiting it: session_create blocks on the
    // (slow) initial worker prompt, so awaiting the turn would miss the mid-run window.
    const controllerId = await createController("E2E_CONTROLLER_PRELUDE", testCwd, serverOutput);
    const previousText = await getLastText(controllerId);
    await requestJson(`/api/agent/${encodeURIComponent(controllerId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "E2E_CREATE_WORKER" }),
    });
    const worker = await waitForSessionInList((s) => s.id !== controllerId && s.orchestration !== undefined, serverOutput);
    const workerId = worker.id;
    assert.ok(worker.orchestration !== undefined, "created session is not an orchestrated worker");

    const deadline = Date.now() + 20_000;
    while (!slow.active && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.ok(slow.active, "worker initial prompt never became active");

    const mRun = await probe(`/api/sessions/${encodeURIComponent(workerId)}?deferThinking=1&deferMedia=1`);
    const sRun = await probe(`/api/sessions/${encodeURIComponent(workerId)}/state`);
    console.log(`[E1 mid worker initial prompt] messages=${mRun.status}  state=${sRun.status} running=${sRun.body?.running}`);

    // After the worker's initial prompt finishes, the controller turn settles.
    await waitForTurn(controllerId, previousText, serverOutput);
    const createdText = await getLastText(controllerId);
    assert.ok(createdText.includes("WORKER_CREATED:"), createdText);

    // Worker wrapper stays alive and idle after the turn → 200 {running:false}.
    const sAfter = await probe(`/api/sessions/${encodeURIComponent(workerId)}/state`);
    const mAfter = await probe(`/api/sessions/${encodeURIComponent(workerId)}?deferThinking=1&deferMedia=1`);
    console.log(`[E2 after worker settled]      messages=${mAfter.status}  state=${sAfter.status} running=${sAfter.body?.running}`);

    assert.equal(mRun.status, 200);
    assert.equal(sRun.status, 200);
    assert.equal(mAfter.status, 200);
    assert.equal(sAfter.status, 200);

    console.log("\nScenario E verdict: orchestrated workers never 404 on /state while their file");
    console.log("exists — the route's orchestration branch answers 200 {running:false} even when no");
    console.log("wrapper is alive. The reported error cannot come from a worker session page either.");

    // Cleanup note: deleting the worker is allowed once idle (no owned children).
    const del = await probe(`/api/sessions/${encodeURIComponent(workerId)}`, { method: "DELETE" });
    console.log(`[E3 delete idle worker]        DELETE=${del.status}`);
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd);
  }
}

await main();
