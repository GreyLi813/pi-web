// Scenario B: opening a session id that never existed in the current agent dir
// (stale link). Both fetches 404 → loadSession bails out at the messages fetch
// and never reaches the state fetch, so it CANNOT produce the reported error.
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertTestPortAvailable, baseUrl, cleanup, createController, getLastText, probe,
  randomSessionId, sendText, sendToolCalls, startModelServer, startWeb,
  latestUserText, trailingToolText, waitForSessionInList, writeTestConfiguration,
  workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-stale-link");
const testCwd = join(workspaceRoot, ".repro-workspace-stale-link");
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
      const peerId = toolText.match(/peer session ([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
      return sendText(response, `PEER_CREATED:${peerId}`);
    }
    if (userText === "E2E_CREATE_PEER") {
      return sendToolCalls(response, [{
        name: "peer_session_create",
        arguments: { name: "B peer", provider: "orchestration-fake", model_id: "orchestration-fake-model-2", thinking_level: "off" },
      }]);
    }
    return sendText(response, `ECHO:${userText}`);
  });

  let webProcess;
  try {
    await writeTestConfiguration(agentDir, model.port);
    ({ child: webProcess } = await startWeb(agentDir, serverOutput));

    const controllerId = await createController("E2E_CREATE_PEER", testCwd, serverOutput);
    const peerId = (await getLastText(controllerId)).match(/PEER_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    await waitForSessionInList((s) => s.id === peerId, serverOutput);

    // B1 — an id that never existed in this agent dir.
    const ghostId = randomSessionId();
    const mGhost = await probe(`/api/sessions/${encodeURIComponent(ghostId)}?deferThinking=1&deferMedia=1`);
    const sGhost = await probe(`/api/sessions/${encodeURIComponent(ghostId)}/state`);
    console.log(`[B1 never-existed id]  messages=${mGhost.status}  state=${sGhost.status}`);

    // B2 — an id whose session file lives in a DIFFERENT agent dir (stale link from another install).
    const otherAgentDir = join(workspaceRoot, ".repro-agent-other-install");
    await mkdir(otherAgentDir, { recursive: true });
    // Find the controller's session dir inside the test agent dir and create a twin session file there
    // BUT ALSO plant the SAME id under a sibling dir layout that the server scan never visits is complex;
    // simpler: copy the peer file into a *non-scanned* sibling agent dir and remove it from the scanned one.
    const peerInfo = await (await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(peerId)}`)).json();
    const scannedDir = dirname(peerInfo.filePath);
    const siblingDir = join(otherAgentDir, "sessions", "sibling");
    await mkdir(siblingDir, { recursive: true });
    // Write a real session file (valid header) into the sibling agent dir only.
    const { readFile } = await import("node:fs/promises");
    const headerLine = (await readFile(peerInfo.filePath, "utf-8")).split("\n").find((l) => l.trim().startsWith('{"type":"session"'));
    const staleId = randomSessionId();
    const staleHeader = JSON.parse(headerLine);
    staleHeader.id = staleId;
    staleHeader.timestamp = new Date().toISOString();
    await writeFile(join(siblingDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${staleId}.jsonl`),
      `${JSON.stringify(staleHeader)}\n`);
    const mStale = await probe(`/api/sessions/${encodeURIComponent(staleId)}?deferThinking=1&deferMedia=1`);
    const sStale = await probe(`/api/sessions/${encodeURIComponent(staleId)}/state`);
    console.log(`[B2 id from other agent dir]  messages=${mStale.status}  state=${sStale.status}`);
    void scannedDir;

    // B3 — control: the real peer still resolves.
    const mReal = await probe(`/api/sessions/${encodeURIComponent(peerId)}?deferThinking=1&deferMedia=1`);
    const sReal = await probe(`/api/sessions/${encodeURIComponent(peerId)}/state`);
    console.log(`[B3 control live peer]         messages=${mReal.status}  state=${sReal.status}`);
    assert.equal(mGhost.status, 404);
    assert.equal(sGhost.status, 404);
    assert.equal(mStale.status, 404);
    assert.equal(sStale.status, 404);
    assert.equal(mReal.status, 200);
    assert.equal(sReal.status, 200);

    console.log("\nScenario B verdict: stale/ghost ids 404 on the MESSAGES fetch first; loadSession");
    console.log("handles that 404 silently (returns null) and never fetches /state. So scenario B");
    console.log("cannot produce the reported console.error on its own.");
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd, join(workspaceRoot, ".repro-agent-other-install"));
  }
}

await main();
