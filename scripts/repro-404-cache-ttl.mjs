// Scenario F (regression check for the resolveSessionPath cache fix):
// F1: A session file created by an EXTERNAL process (e.g. the pi CLI sharing the
//     agent dir) never triggers pi-web's in-process cacheSessionPath /
//     invalidateSessionList hooks. resolveSessionPath must recover with one forced
//     fresh scan instead of false-404ing for the whole 30s list-cache window.
// F2: Control — a peer created IN-PROCESS (via the AI tool) calls the hooks, so it
//     never 404s even immediately after creation.
// F3: EXTERNAL deletion must drop the stale path cache entry and report 404
//     instead of serving a synthetic empty session.
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertTestPortAvailable, cleanup, createController, getLastText, probe,
  randomSessionId, requestJson, sendText, sendToolCalls, startModelServer, startWeb,
  latestUserText, trailingToolText, waitForSessionInList, waitForTurn,
  writeTestConfiguration, workspaceRoot,
} from "./repro-404-lib.mjs";

const agentDir = join(workspaceRoot, ".repro-agent-cache-ttl");
const testCwd = join(workspaceRoot, ".repro-workspace-cache-ttl");
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
        arguments: { name: "F control peer", provider: "orchestration-fake", model_id: "orchestration-fake-model-2", thinking_level: "off" },
      }]);
    }
    return sendText(response, `ECHO:${userText}`);
  });

  let webProcess;
  try {
    await writeTestConfiguration(agentDir, model.port);
    ({ child: webProcess } = await startWeb(agentDir, serverOutput));

    const controllerId = await createController("E2E_CREATE_PEER", testCwd, serverOutput);
    const controlPeerId = (await getLastText(controllerId)).match(/PEER_CREATED:([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)?.[1];
    await waitForSessionInList((s) => s.id === controlPeerId, serverOutput);

    // ---- F2 control: in-process peer never 404s, even immediately after creation.
    const mCtl = await probe(`/api/sessions/${encodeURIComponent(controlPeerId)}?deferThinking=1&deferMedia=1`);
    const sCtl = await probe(`/api/sessions/${encodeURIComponent(controlPeerId)}/state`);
    console.log(`[F2 control in-process peer]   messages=${mCtl.status}  state=${sCtl.status}`);

    // ---- F1: simulate an EXTERNAL process creating a session file in the SAME agent dir.
    // 1. Warm the server's 30s list TTL cache (GET /api/sessions) — external creation
    //    does not invalidate it.
    const listWarm = await requestJson("/api/sessions");
    void listWarm;
    // 2. Write a valid session file directly on disk, same session dir as the controller.
    const controllerInfo = await requestJson(`/api/sessions/${encodeURIComponent(controllerId)}`);
    const sessionDir = dirname(controllerInfo.filePath);
    const externalId = randomSessionId();
    const headerLine = (await readFile(controllerInfo.filePath, "utf-8")).split("\n")
      .find((l) => l.trim().startsWith('{"type":"session"'));
    const header = JSON.parse(headerLine);
    const fileTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const externalPath = join(sessionDir, `${fileTimestamp}_${externalId}.jsonl`);
    await writeFile(externalPath, [
      JSON.stringify({ ...header, id: externalId, timestamp: new Date().toISOString(), parentSession: undefined }),
      JSON.stringify({ type: "session_info", id: `info-${externalId.slice(0, 8)}`, parentId: null, timestamp: new Date().toISOString(), name: "Externally created" }),
    ].join("\n") + "\n");

    // 3. The file exists on disk, but the TTL list cache does not know it yet.
    const onDisk = await readFile(externalPath, "utf-8").then((c) => c.length > 0);
    assert.ok(onDisk, "external session file should exist on disk");

    const m1 = await probe(`/api/sessions/${encodeURIComponent(externalId)}?deferThinking=1&deferMedia=1`);
    const s1 = await probe(`/api/sessions/${encodeURIComponent(externalId)}/state`);
    const list1 = await requestJson("/api/sessions");
    console.log(`[F1 external file, TTL fresh]  messages=${m1.status}  state=${s1.status}  visible-in-list=${list1.sessions.some((s) => s.id === externalId)}  file-on-disk=true`);

    // 4. Any list invalidation (e.g. an agent_end from another session) heals it instantly.
    //    Simulate with a second controller turn that emits agent_end events.
    const healPrevious = await getLastText(controllerId);
    await requestJson(`/api/agent/${encodeURIComponent(controllerId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "F_HEAL" }),
    });
    await waitForTurn(controllerId, healPrevious, serverOutput);
    const m2 = await probe(`/api/sessions/${encodeURIComponent(externalId)}?deferThinking=1&deferMedia=1`);
    const s2 = await probe(`/api/sessions/${encodeURIComponent(externalId)}/state`);
    console.log(`[F1 after list invalidation]   messages=${m2.status}  state=${s2.status}`);

    // 4. Repeat with a second external file; the same forced rescan must apply.
    const externalId2 = randomSessionId();
    const externalPath2 = join(sessionDir, `${fileTimestamp}_${externalId2}.jsonl`);
    await writeFile(externalPath2, await readFile(externalPath, "utf-8").then((c) => c.replace(externalId, externalId2)));
    const m3 = await probe(`/api/sessions/${encodeURIComponent(externalId2)}?deferThinking=1&deferMedia=1`);
    const s3 = await probe(`/api/sessions/${encodeURIComponent(externalId2)}/state`);
    console.log(`[F1b external file #2, TTL fresh] messages=${m3.status}  state=${s3.status}`);

    // ---- F3: EXTERNAL deletion — the stale path cache entry must be dropped and both
    // probes must report 404 instead of opening a synthetic empty session.
    const { unlink } = await import("node:fs/promises");
    await unlink(externalPath2);
    const m5 = await probe(`/api/sessions/${encodeURIComponent(externalId2)}?deferThinking=1&deferMedia=1`);
    const s5 = await probe(`/api/sessions/${encodeURIComponent(externalId2)}/state`);
    console.log(`[F3 external delete, stale path cache] messages=${m5.status} state=${s5.status} (fixed: both 404)`);

    assert.equal(mCtl.status, 200);
    assert.equal(sCtl.status, 200);
    assert.equal(m1.status, 200, "external session must resolve despite the fresh TTL cache");
    assert.equal(s1.status, 200, "state must resolve despite the fresh TTL cache");
    assert.equal(m2.status, 200);
    assert.equal(s2.status, 200);
    assert.equal(m3.status, 200);
    assert.equal(s3.status, 200);
    assert.equal(m5.status, 404, "externally deleted session must 404, not synthesize an empty session");
    assert.equal(s5.status, 404, "externally deleted session state must 404");

    console.log("\nScenario F verdict: FIXED — externally created sessions resolve immediately (one forced");
    console.log("fresh scan on a TTL-cache miss), and externally deleted sessions report 404 instead of");
    console.log("serving a synthetic empty session from a stale path cache.");
  } finally {
    await cleanup(model, webProcess, agentDir, testCwd);
  }
}

await main();
