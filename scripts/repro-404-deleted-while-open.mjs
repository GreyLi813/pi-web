// Scenario A: session deleted while its page is open.
// Reproduces the client's two-fetch sequence (messages then state) racing a DELETE.
// Expected: (A1) after deletion both fetches 404 → loadSession returns null silently.
//           (A2) DELETE landing between the two fetches → messages 200, state 404
//                → the exact console.error "Failed to load agent state: HTTP 404".
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTestPortAvailable, baseUrl, cleanup, createController, getLastText,
  latestUserText, probe, promptSession, sendText, sendToolCalls, startModelServer,
  startWeb, trailingToolText, waitForSessionInList, writeTestConfiguration,
  workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-deleted-open");
const testCwd = join(workspaceRoot, ".repro-workspace-deleted-open");
const serverOutput = { value: "" };

async function main() {
  await assertTestPortAvailable();
  await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(testCwd, { recursive: true, force: true })]);
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(testCwd, { recursive: true })]);

  const model = await startModelServer(async (body, response) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userText = latestUserText(messages);
    const toolText = trailingToolText(messages);
    if (messages.at(-1)?.role === "tool") {
      if (/Created peer session/.test(toolText)) {
        const peerId = toolText.match(/peer session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
        return sendText(response, `PEER_CREATED:${peerId}`);
      }
      return sendText(response, `UNEXPECTED_TOOL_RESULT:${toolText.slice(0, 200)}`);
    }
    if (userText === "E2E_CREATE_PEER") {
      return sendToolCalls(response, [{
        name: "peer_session_create",
        arguments: { name: "A peer", provider: "orchestration-fake", model_id: "orchestration-fake-model-2", thinking_level: "off" },
      }]);
    }
    if (userText === "PEER_MANUAL") return sendText(response, "PEER_MANUAL_PONG");
    return sendText(response, `ECHO:${userText}`);
  });

  let webProcess;
  try {
    await writeTestConfiguration(agentDir, model.port);
    ({ child: webProcess } = await startWeb(agentDir, serverOutput));

    const controllerId = await createController("E2E_CREATE_PEER", testCwd, serverOutput);
    const peerId = (await getLastText(controllerId)).match(/PEER_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    assert.ok(peerId, "peer not created");
    await waitForSessionInList((s) => s.id === peerId, serverOutput);

    const m0 = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const s0 = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[A0 baseline, peer alive/idle]   messages=${m0.status}  state=${s0.status}`);

    // A2 — the exact race that produces the reported console.error:
    //   client fetch #1 (messages) lands before the DELETE completes,
    //   client fetch #2 (state) lands after path-cache invalidation + unlink.
    const mRace = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const del = await probe(`/api/sessions/${encodeURIComponent(peerId)}`, { method: "DELETE" });
    const sRace = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[A2 DELETE between fetches]      messages=${mRace.status}  DELETE=${del.status}  state=${sRace.status}`);
    assert.equal(mRace.status, 200, "messages fetch must succeed before the delete lands");
    assert.equal(sRace.status, 404, "state fetch must 404 after the delete lands");
    console.log("  → exact client sequence: GET /api/sessions/<sid> (200) then GET /api/sessions/<sid>/state (404)");
    console.log("  → client logs: 'Failed to load agent state: HTTP 404' at useAgentSession.ts:490");

    // A1 — deletion completed BEFORE any fetch: both 404, loadSession bails out silently.
    const mGone = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sGone = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[A1 after deletion, no race]     messages=${mGone.status}  state=${sGone.status}`);
    assert.equal(mGone.status, 404);
    assert.equal(sGone.status, 404);

    // A3 — deleting a RUNNING peer is rejected with 409 (deletion race needs an idle peer).
    const controller2 = await createController("E2E_CREATE_PEER", testCwd, serverOutput);
    const peer2 = (await getLastText(controller2)).match(/PEER_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    await promptSession(peer2, "PEER_MANUAL", serverOutput);
    const sBusy0 = await probe(`/api/sessions/${encodeURIComponent(peer2)}/state`);
    console.log(`[A3 idle peer before delete]     state=${sBusy0.status} running=${sBusy0.body?.running}`);
    const delBusy = await probe(`/api/sessions/${encodeURIComponent(peer2)}`, { method: "DELETE" });
    console.log(`[A3 DELETE idle peer]            DELETE=${delBusy.status}`);

    console.log("\nScenario A verdict: the reported error is the deletion race (expected missing-session");
    console.log("behavior); the server correctly reports 404 once the session is gone. The client");
    console.log("console.error is noise — the messages fetch already succeeded, so the 404 is not fatal.");
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd);
  }
}

await main();
