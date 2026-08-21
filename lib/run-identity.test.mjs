import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { acceptRunIdentity } = await jiti.import("./run-identity.ts");
const { getRpcRuntimeInstanceId } = await jiti.import("./rpc-manager.ts");

test("newer run epochs replace state and older responses are rejected", () => {
  const current = { runtimeInstanceId: "runtime-a", epoch: 7, runId: "new-run", retiredInstanceIds: [] };
  assert.deepEqual(acceptRunIdentity(current, { runEpoch: 6, runId: "old-run" }), {
    accepted: false,
    identity: current,
  });
  assert.deepEqual(acceptRunIdentity(current, { runEpoch: 8, runId: "next-run" }), {
    accepted: true,
    identity: { runtimeInstanceId: "runtime-a", epoch: 8, runId: "next-run", retiredInstanceIds: [] },
  });
});

test("same-epoch events from a different run cannot mutate client state", () => {
  const current = { runtimeInstanceId: "runtime-a", epoch: 7, runId: "active-run", retiredInstanceIds: [] };
  assert.equal(acceptRunIdentity(current, { runEpoch: 7, runId: "stale-run" }).accepted, false);
  assert.equal(acceptRunIdentity(current, { runEpoch: 7, runId: "active-run" }).accepted, true);
  assert.deepEqual(acceptRunIdentity(current, { runEpoch: 7, runId: null }).identity, current);
});

test("a new runtime instance resets epochs but events from the retired instance stay rejected", () => {
  const current = { runtimeInstanceId: "runtime-old", epoch: 90, runId: "old-run", retiredInstanceIds: [] };
  const restarted = acceptRunIdentity(current, {
    runtimeInstanceId: "runtime-new",
    runEpoch: 1,
    runId: "new-run",
  });
  assert.deepEqual(restarted, {
    accepted: true,
    identity: {
      runtimeInstanceId: "runtime-new",
      epoch: 1,
      runId: "new-run",
      retiredInstanceIds: ["runtime-old"],
    },
  });
  assert.equal(acceptRunIdentity(restarted.identity, {
    runtimeInstanceId: "runtime-old",
    runEpoch: 91,
    runId: "late-old-run",
  }).accepted, false);
});

test("each fresh server global receives a new runtime instance ID", () => {
  const first = getRpcRuntimeInstanceId();
  globalThis.__piRpcRuntimeInstanceId = undefined;
  const second = getRpcRuntimeInstanceId();
  assert.notEqual(second, first);
});

test("malformed epochs and runtime instance IDs fail closed", () => {
  const current = { runtimeInstanceId: "runtime-a", epoch: 2, runId: null, retiredInstanceIds: [] };
  assert.equal(acceptRunIdentity(current, { runEpoch: -1 }).accepted, false);
  assert.equal(acceptRunIdentity(current, { runEpoch: 2.5 }).accepted, false);
  assert.equal(acceptRunIdentity(current, { runEpoch: "3" }).accepted, false);
  assert.equal(acceptRunIdentity(current, { runtimeInstanceId: "", runEpoch: 0 }).accepted, false);
});
