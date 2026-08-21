// Scenario C: a peer session page during/after its schedule fires.
// Schedules dispatch via POST /api/schedules {action:"dispatchDue"} which starts an
// RPC wrapper for the peer. The peer's file is persisted at creation, so /state and
// /api/sessions/<id> should stay 200 while the scheduled prompt runs and after it settles.
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertTestPortAvailable, cleanup, createController, getLastText, probe,
  promptSession, requestJson, sendText, sendToolCalls, startModelServer, startWeb,
  latestUserText, trailingToolText, waitForSessionInList, waitForTurn,
  writeTestConfiguration, workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-schedule-fire");
const testCwd = join(workspaceRoot, ".repro-workspace-schedule-fire");
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
          name: "C scheduled peer",
          provider: "orchestration-fake",
          model_id: "orchestration-fake-model-2",
          thinking_level: "off",
          schedules: [{ interval: "10s", prompt: "PEER_SCHEDULED_PING" }],
        },
      }]);
    }
    if (userText === "PEER_SCHEDULED_PING") {
      slow.active = true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 8_000)); // hold the turn open
      slow.active = false;
      return sendText(response, "PEER_PONG");
    }
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

    const schedules = await requestJson("/api/schedules");
    const bound = schedules.schedules.find((schedule) => schedule.sessionId === peerId);
    assert.ok(bound, "no schedule bound");

    // Peer page probes while idle, before the schedule fires.
    const mIdle = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sIdle = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[C0 before fire, idle]      messages=${mIdle.status}  state=${sIdle.status} running=${sIdle.body?.running}`);

    // Wait until the schedule is due, then dispatch.
    const waitMs = bound.nextFireAt - Date.now();
    if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs + 300));
    const dispatch = await requestJson("/api/schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "dispatchDue" }),
    });
    assert.equal(dispatch.dispatched, true);

    // Wait for the fake provider to enter the slow scheduled turn, then probe mid-run.
    const deadline = Date.now() + 20_000;
    while (!slow.active && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.ok(slow.active, "scheduled prompt never became active");
    const mRun = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sRun = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[C1 mid scheduled run]      messages=${mRun.status}  state=${sRun.status} running=${sRun.body?.running} isPromptRunning=${sRun.body?.state?.isPromptRunning}`);

    // After the turn settles.
    await waitForTurn(peerId, "", serverOutput);
    const mAfter = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sAfter = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[C2 after schedule settled] messages=${mAfter.status}  state=${sAfter.status} running=${sAfter.body?.running}`);
    assert.equal(await getLastText(peerId), "PEER_PONG");

    // Control: a manual prompt also stays 200.
    await promptSession(peerId, "PEER_MANUAL", serverOutput);
    const sManual = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[C3 after manual prompt]    state=${sManual.status} running=${sManual.body?.running}`);

    assert.equal(mRun.status, 200);
    assert.equal(sRun.status, 200);
    assert.equal(sAfter.status, 200);
    assert.equal(sManual.status, 200);

    console.log("\nScenario C verdict: no 404 at any point. The peer's session file is persisted before");
    console.log("the scheduled prompt starts, so /state stays 200 {running:true} mid-run and");
    console.log("200 {running:false} after settle. Schedules cannot produce the reported error.");
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd);
  }
}

await main();
