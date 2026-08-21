import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { cancelRunWithRecheck } = await jiti.import("./run-cancellation.ts");

test("does not cancel an older run while the requested POST identity is pending", async () => {
  const cancelled = [];
  const result = await cancelRunWithRecheck({
    requestedRunId: "new-run",
    identity: { runId: "old-run", runEpoch: 7 },
    getState: async () => ({ runId: "old-run", runEpoch: 7 }),
    cancel: async (identity) => { cancelled.push(identity); return { cancelled: true }; },
  });
  assert.equal(result, false);
  assert.deepEqual(cancelled, []);
});

test("cancels immediately when the pending POST returns its exact identity", async () => {
  const cancelled = [];
  const result = await cancelRunWithRecheck({
    requestedRunId: "new-run",
    identity: { runId: "new-run", runEpoch: 8 },
    getState: async () => ({ runId: null, runEpoch: 8 }),
    cancel: async (identity) => { cancelled.push(identity); return { cancelled: true }; },
  });
  assert.equal(result, true);
  assert.deepEqual(cancelled, [{ runId: "new-run", runEpoch: 8 }]);
});

test("cancel false re-reads state and retries only the same exact run", async () => {
  const cancelled = [];
  const result = await cancelRunWithRecheck({
    requestedRunId: "new-run",
    identity: { runId: "new-run", runEpoch: 8 },
    getState: async () => ({ runId: "new-run", runEpoch: 9 }),
    cancel: async (identity) => {
      cancelled.push(identity);
      return { cancelled: cancelled.length > 1 };
    },
  });
  assert.equal(result, true);
  assert.deepEqual(cancelled, [
    { runId: "new-run", runEpoch: 8 },
    { runId: "new-run", runEpoch: 9 },
  ]);
});
