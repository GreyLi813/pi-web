// Scenario D: a peer created with initial_prompt — probing its page mid-run
// while the peer wrapper is starting/running the initial prompt.
// Expected: file is persisted synchronously BEFORE the initial prompt starts,
// so messages+state both return 200 during the run.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTestPortAvailable, cleanup, createController, getLastText, probe,
  requestJson, sendText, sendToolCalls, startModelServer, startWeb,
  latestUserText, trailingToolText, waitForSessionInList, waitForTurn,
  writeTestConfiguration, workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-initial-prompt");
const testCwd = join(workspaceRoot, ".repro-workspace-initial-prompt");
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
      const peerId = toolText.match(/peer session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `PEER_CREATED:${peerId}`);
    }
    if (userText === "E2E_CREATE_PEER") {
      return sendToolCalls(response, [{
        name: "peer_session_create",
        arguments: {
          name: "D initial peer",
          provider: "orchestration-fake",
          model_id: "orchestration-fake-model-2",
          thinking_level: "off",
          initial_prompt: "PEER_FIRST_PING",
        },
      }]);
    }
    if (userText === "PEER_FIRST_PING") {
      slow.active = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000)); // hold the initial turn open
      slow.active = false;
      return sendText(response, "PEER_FIRST_PONG");
    }
    return sendText(response, `ECHO:${userText}`);
  });

  let webProcess;
  try {
    await writeTestConfiguration(agentDir, model.port);
    ({ child: webProcess } = await startWeb(agentDir, serverOutput));

    // Start the controller turn WITHOUT awaiting it: the peer_session_create tool blocks
    // on the (slow) initial prompt, so awaiting the turn would miss the mid-run window.
    const controllerId = await createController("E2E_CONTROLLER_PRELUDE", testCwd, serverOutput);
    const previousText = await getLastText(controllerId);
    await requestJson(`/api/agent/${encodeURIComponent(controllerId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "E2E_CREATE_PEER" }),
    });

    // The controller turn is now running the peer_session_create tool. The peer file is
    // persisted synchronously, then the initial prompt starts (slow). Poll the session
    // list for the peer to appear and grab its id mid-run.
    const peer = await waitForSessionInList((s) => s.id !== controllerId, serverOutput);
    const peerId = peer.id;
    const deadline = Date.now() + 20_000;
    while (!slow.active && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.ok(slow.active, "initial prompt never became active");

    const mRun = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sRun = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[D1 mid initial prompt]     messages=${mRun.status}  state=${sRun.status} running=${sRun.body?.running} isPromptRunning=${sRun.body?.state?.isPromptRunning}`);

    // Peer visible in the list while its wrapper is running.
    const listRun = await requestJson("/api/sessions");
    assert.ok(listRun.sessions.some((s) => s.id === peerId), "peer missing from list mid-run");

    // After the tool completes, the controller turn settles.
    await waitForTurn(controllerId, previousText, serverOutput);
    const createdText = await getLastText(controllerId);
    assert.ok(createdText.includes("PEER_CREATED:"), createdText);
    assert.equal(await getLastText(peerId), "PEER_FIRST_PONG");

    const mAfter = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sAfter = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[D2 after initial prompt]   messages=${mAfter.status}  state=${sAfter.status} running=${sAfter.body?.running}`);

    assert.equal(mRun.status, 200);
    assert.equal(sRun.status, 200);
    assert.equal(mAfter.status, 200);
    assert.equal(sAfter.status, 200);

    console.log("\nScenario D verdict: no 404. createPeerSession persists the session file BEFORE");
    console.log("the initial prompt runs and the pi-web hook caches the path immediately, so the");
    console.log("peer page loads 200/200 even while the initial turn is still streaming.");
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd);
  }
}

await main();
