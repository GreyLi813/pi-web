import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createCodexImportTestRoot } from "./codex-import-test-support.mjs";

const jiti = createJiti(import.meta.url);
const {
  CodexImportError,
  applySemanticCompaction,
  createFileCompactionCheckpointStore,
  executeSemanticCompactionPlan,
  planSemanticCompaction,
  validateCompactionCoverage,
} = await jiti.import("./codex-import/index.ts");

const CURRENT_MODEL = {
  provider: "openai-codex",
  id: "current",
  contextWindow: 12_000,
  maxTokens: 2_000,
  available: true,
};

/**
 * Build zero-cost assistant usage for compaction fixtures.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function usage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Build the native structured summary shape required by coverage validation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function summaryText(label) {
  return `## Goal\n${label}\n\n## Constraints & Preferences\n- preserve constraints\n\n`
    + "## Progress\n### Done\n- completed work\n\n"
    + "## Key Decisions\n- retained decisions\n\n## Next Steps\n1. continue\n\n"
    + "## Critical Context\n- retained context";
}

/**
 * Append one complete semantic task with an optional closed tool cycle.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendTask(entries, index, textSize, withTool = false) {
  let parentId = entries.at(-1)?.id ?? null;
  const userId = `u${index}`;
  entries.push({
    type: "message",
    id: userId,
    parentId,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    message: { role: "user", content: `Task ${index}\n${"u".repeat(textSize)}`, timestamp: Date.now() },
  });
  parentId = userId;
  if (withTool) {
    const assistantId = `tc${index}`;
    const callId = `call_${index}`;
    entries.push({
      type: "message",
      id: assistantId,
      parentId,
      timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.100Z`,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `file-${index}.txt` } }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "current",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
    });
    entries.push({
      type: "message",
      id: `tr${index}`,
      parentId: assistantId,
      timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.200Z`,
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "read",
        content: [{ type: "text", text: "r".repeat(textSize) }],
        isError: false,
        timestamp: Date.now(),
      },
    });
    parentId = `tr${index}`;
  }
  entries.push({
    type: "message",
    id: `a${index}`,
    parentId,
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, "0")}.900Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Done ${index}\n${"a".repeat(textSize)}` }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "current",
      usage: usage(),
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
}

/**
 * Create a linear set of complete task entries.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createTaskEntries(count, textSize, withTool = false) {
  const entries = [];
  for (let index = 1; index <= count; index += 1) appendTask(entries, index, textSize, withTool);
  return entries;
}

test("keeps a context-safe import uncompressed", () => {
  const entries = createTaskEntries(2, 100);
  const plan = planSemanticCompaction({
    entries,
    currentModel: CURRENT_MODEL,
    availableModels: [CURRENT_MODEL],
    sourceVersion: "safe-source",
  });
  assert.equal(plan.mode, "none");
  assert.equal(plan.lossy, false);
  assert.equal(plan.estimatedCalls, 0);
  assert.equal(plan.firstKeptEntryId, null);
});

test("plans one native semantic summary while retaining recent complete tasks", () => {
  const entries = createTaskEntries(5, 3_000, true);
  const plan = planSemanticCompaction({
    entries,
    currentModel: { ...CURRENT_MODEL, contextWindow: 8_000 },
    availableModels: [{ ...CURRENT_MODEL, contextWindow: 8_000 }],
    sourceVersion: "single-source",
    keepRecentTokens: 1_000,
  });

  assert.equal(plan.mode, "single");
  assert.equal(plan.lossy, true);
  assert.equal(plan.estimatedChunks, 1);
  assert.equal(plan.estimatedLayers, 1);
  assert.equal(plan.estimatedCalls, 1);
  assert.ok(plan.keptEntryIds.includes(entries.at(-1).id));
  assert.ok(plan.summaryEntryIds.length > 0);
  validateCompactionCoverage(plan, entries);
});

test("executes one native-style semantic summary call and applies firstKeptEntryId", async () => {
  const entries = createTaskEntries(5, 3_000, true);
  const model = { ...CURRENT_MODEL, contextWindow: 8_000 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "single-execution",
    keepRecentTokens: 1_000,
  });
  assert.equal(plan.mode, "single");
  const records = new Map();
  const result = await executeSemanticCompactionPlan({
    plan,
    entries,
    checkpointStore: {
      load: async (callId) => records.get(callId),
      save: async (callId, record) => { records.set(callId, record); },
      remove: async () => { records.clear(); },
    },
    summarize: async () => ({ text: summaryText("single semantic checkpoint"), usage: usage() }),
  });
  assert.equal(result.callCount, 1);
  const compacted = applySemanticCompaction({ entries, plan, result });
  assert.equal(compacted.at(-1).type, "compaction");
  assert.equal(compacted.at(-1).firstKeptEntryId, plan.firstKeptEntryId);
});

test("keeps exact critical constraints and file operations in active context", async () => {
  const entries = createTaskEntries(5, 3_000, true);
  entries[0].message.content = "重构认证模块\n请勿修改生产配置\nJava 7 is required.\n接口 X 应保持不变";
  entries[1].message.content[0].name = "exec_command";
  entries[1].message.content[0].arguments = { cmd: "rm src/auth.ts && mv src/new.ts src/current.ts" };
  entries[2].message.toolName = "exec_command";
  entries[2].message.content[0].text = "Migration failed: EACCES；重试尚未完成；决定改用接口 Y";
  entries[3].message.content.unshift({ type: "thinking", thinking: "迁移尚未完成；决定改用接口 Z" });
  entries[5].message.content[0].name = "apply_patch";
  entries[5].message.content[0].arguments = {
    input: "*** Begin Patch\n*** Update File: src/auth.ts\n*** Move to: src/security/auth.ts\n*** End Patch",
  };
  entries[6].message.toolName = "apply_patch";
  entries[6].message.isError = true;
  entries[6].message.content[0].text = "Process exited with code 1";
  const model = { ...CURRENT_MODEL, contextWindow: 8_000 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "critical-constraints",
    keepRecentTokens: 1_000,
  });
  const records = new Map();
  const result = await executeSemanticCompactionPlan({
    plan,
    entries,
    checkpointStore: {
      load: async (callId) => records.get(callId),
      save: async (callId, record) => { records.set(callId, record); },
      remove: async () => { records.clear(); },
    },
    summarize: async () => ({ text: summaryText("generic model summary"), usage: usage() }),
  });
  const compacted = applySemanticCompaction({ entries, plan, result });
  assert.match(compacted.at(-1).summary, /请勿修改生产配置/);
  assert.match(compacted.at(-1).summary, /Java 7 is required/);
  assert.match(compacted.at(-1).summary, /接口 X 应保持不变/);
  assert.match(compacted.at(-1).summary, /shell-command:rm src\/auth\.ts && mv src\/new\.ts src\/current\.ts/);
  assert.match(compacted.at(-1).summary, /File operation: modified:src\/auth\.ts/);
  assert.match(compacted.at(-1).summary, /File operation: modified:src\/security\/auth\.ts/);
  assert.match(compacted.at(-1).summary, /Migration failed: EACCES/);
  assert.match(compacted.at(-1).summary, /迁移尚未完成/);
  assert.match(compacted.at(-1).summary, /决定改用接口 Z/);
  assert.match(compacted.at(-1).summary, /Failed tool outcome: Process exited with code 1/);
});

test("rejects an actual summary that exceeds its signed parent-merge budget", async () => {
  const entries = createTaskEntries(5, 3_000, true);
  const model = { ...CURRENT_MODEL, contextWindow: 8_000 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "large-summary-output",
    keepRecentTokens: 1_000,
  });
  await assert.rejects(
    () => executeSemanticCompactionPlan({
      plan,
      entries,
      checkpointStore: {
        load: async () => undefined,
        save: async () => undefined,
        remove: async () => undefined,
      },
      summarize: async () => ({ text: "x".repeat(plan.reserveTokens * 8), usage: usage() }),
    }),
    (error) => error instanceof CodexImportError && error.code === "SEMANTIC_SUMMARY_TOO_LARGE",
  );
});

test("rejects a non-semantic checkpoint even when it is non-empty", async () => {
  const entries = createTaskEntries(5, 3_000, true);
  const model = { ...CURRENT_MODEL, contextWindow: 8_000 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "empty-semantic-coverage",
    keepRecentTokens: 1_000,
  });
  await assert.rejects(
    () => executeSemanticCompactionPlan({
      plan,
      entries,
      checkpointStore: {
        load: async () => undefined,
        save: async () => undefined,
        remove: async () => undefined,
      },
      summarize: async () => ({ text: "Done.", usage: usage() }),
    }),
    (error) => error instanceof CodexImportError && error.code === "SEMANTIC_SUMMARY_INCOMPLETE",
  );
});

test("plans hierarchical summaries on complete semantic units without splitting tool pairs", () => {
  const entries = createTaskEntries(12, 4_000, true);
  const model = { ...CURRENT_MODEL, contextWindow: 7_000, maxTokens: 1_200 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "hierarchical-source",
    keepRecentTokens: 800,
  });

  assert.equal(plan.mode, "hierarchical");
  assert.ok(plan.estimatedChunks > 1);
  assert.ok(plan.estimatedLayers > 1);
  assert.ok(plan.estimatedCalls >= plan.estimatedChunks + 1);
  for (const chunk of plan.leafChunks) {
    const chunkIds = new Set(chunk.entryIds);
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const block of entry.message.content) {
        if (block.type !== "toolCall" || !chunkIds.has(entry.id)) continue;
        const result = entries.find((candidate) => candidate.type === "message"
          && candidate.message.role === "toolResult"
          && candidate.message.toolCallId === block.id);
        assert.ok(result && chunkIds.has(result.id));
      }
    }
  }
  validateCompactionCoverage(plan, entries);
});

test("splits an oversized task only at closed assistant phases and rejects an unsafe monolith", () => {
  const phaseEntries = createTaskEntries(1, 100);
  let parentId = phaseEntries[0].id;
  phaseEntries.splice(1, phaseEntries.length - 1);
  for (let index = 1; index <= 4; index += 1) {
    const id = `phase${index}`;
    phaseEntries.push({
      type: "message",
      id,
      parentId,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `## Phase ${index}\n${"x".repeat(8_000)}` }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "current",
        usage: usage(),
        stopReason: index === 4 ? "stop" : "stop",
        timestamp: Date.now(),
      },
    });
    parentId = id;
  }
  const model = { ...CURRENT_MODEL, contextWindow: 5_000, maxTokens: 1_000 };
  const splitPlan = planSemanticCompaction({
    entries: phaseEntries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "oversized-safe",
    keepRecentTokens: 100,
  });
  assert.equal(splitPlan.mode, "hierarchical");
  assert.ok(splitPlan.leafChunks.length > 1);
  assert.ok(splitPlan.leafChunks.every((chunk) => chunk.continuity));

  const unsafeEntries = createTaskEntries(1, 40_000);
  assert.throws(
    () => planSemanticCompaction({
      entries: unsafeEntries,
      currentModel: model,
      availableModels: [model],
      sourceVersion: "oversized-unsafe",
      keepRecentTokens: 100,
    }),
    (error) => error instanceof CodexImportError && error.code === "LONG_CONTEXT_MODEL_UNAVAILABLE",
  );
});

test("requires an available long model and explicit confirmation before crossing providers", () => {
  const entries = createTaskEntries(1, 40_000);
  const current = { ...CURRENT_MODEL, contextWindow: 5_000, maxTokens: 1_000 };
  const crossProvider = {
    provider: "anthropic",
    id: "authorized-long",
    contextWindow: 200_000,
    maxTokens: 8_000,
    available: true,
  };

  assert.throws(
    () => planSemanticCompaction({
      entries,
      currentModel: current,
      availableModels: [current, crossProvider],
      sourceVersion: "cross-provider",
      keepRecentTokens: 100,
    }),
    (error) => error instanceof CodexImportError && error.code === "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
  );

  const confirmed = planSemanticCompaction({
    entries,
    currentModel: current,
    availableModels: [current, crossProvider],
    sourceVersion: "cross-provider",
    keepRecentTokens: 100,
    crossProviderConfirmed: true,
    crossProviderModel: { provider: "anthropic", modelId: "authorized-long" },
  });
  assert.equal(confirmed.compressionModel.provider, "anthropic");
  assert.equal(confirmed.crossProvider, true);

  const endpointBoundCurrent = { ...current, endpointFingerprint: "endpoint-a" };
  const alternateEndpoint = {
    ...crossProvider,
    provider: endpointBoundCurrent.provider,
    id: "same-provider-other-endpoint",
    endpointFingerprint: "endpoint-b",
  };
  assert.throws(
    () => planSemanticCompaction({
      entries,
      currentModel: endpointBoundCurrent,
      availableModels: [endpointBoundCurrent, alternateEndpoint],
      sourceVersion: "cross-endpoint",
      keepRecentTokens: 100,
    }),
    (error) => error instanceof CodexImportError && error.code === "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
  );
});

test("authenticates checkpoint text before resuming it", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const store = createFileCompactionCheckpointStore({
    agentDir: fixture.agentDir,
    threadId: "checkpoint-integrity",
    sourceVersion: "source-integrity",
    planHash: "plan-integrity",
  });
  await store.save("call-one", {
    text: "trusted checkpoint",
    entryIds: ["entry-one"],
    inputHash: "input-one",
  });
  const reopened = createFileCompactionCheckpointStore({
    agentDir: fixture.agentDir,
    threadId: "checkpoint-integrity",
    sourceVersion: "source-integrity",
    planHash: "plan-integrity",
  });
  assert.equal((await reopened.load("call-one")).text, "trusted checkpoint");
  const checkpointFile = join(store.directory, readdirSync(store.directory).find((name) => name.endsWith(".json")));
  const envelope = JSON.parse(readFileSync(checkpointFile, "utf8"));
  envelope.record.text = "tampered checkpoint";
  writeFileSync(checkpointFile, `${JSON.stringify(envelope)}\n`);
  await assert.rejects(
    () => store.load("call-one"),
    (error) => error instanceof CodexImportError && error.code === "COMPACTION_CHECKPOINT_INVALID",
  );
});

test("checkpoints each summary call and resumes after an injected mid-plan failure", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const entries = createTaskEntries(10, 4_000, true);
  const model = { ...CURRENT_MODEL, contextWindow: 7_000, maxTokens: 1_200 };
  const plan = planSemanticCompaction({
    entries,
    currentModel: model,
    availableModels: [model],
    sourceVersion: "checkpoint-source",
    keepRecentTokens: 500,
  });
  assert.equal(plan.mode, "hierarchical");
  const checkpointStore = createFileCompactionCheckpointStore({
    agentDir: fixture.agentDir,
    threadId: "checkpoint-thread",
    sourceVersion: "checkpoint-source",
    planHash: plan.planHash,
  });
  let attempts = 0;
  const completedCallIds = new Set();

  await assert.rejects(
    () => executeSemanticCompactionPlan({
      plan,
      entries,
      checkpointStore,
      summarize: async (call) => {
        attempts += 1;
        if (attempts === 2) throw new Error("injected summary failure");
        completedCallIds.add(call.id);
        return { text: summaryText(`summary:${call.id}`), usage: usage() };
      },
    }),
    /injected summary failure/,
  );
  const attemptsAfterFailure = attempts;

  const result = await executeSemanticCompactionPlan({
    plan,
    entries,
    checkpointStore,
    summarize: async (call) => {
      attempts += 1;
      assert.equal(completedCallIds.has(call.id), false, "completed checkpoint call must not run twice");
      completedCallIds.add(call.id);
      return { text: summaryText(`summary:${call.id}`), usage: usage() };
    },
  });
  assert.ok(attempts < attemptsAfterFailure + plan.calls.length);
  assert.match(result.summary, /summary:/);
  assert.deepEqual(new Set(result.coveredEntryIds), new Set(plan.summaryEntryIds));

  const compacted = applySemanticCompaction({ entries, plan, result });
  assert.equal(compacted.at(-1).type, "compaction");
  assert.equal(compacted.at(-1).firstKeptEntryId, plan.firstKeptEntryId);
  assert.match(compacted.at(-1).summary, /Verified import coverage|Original request: Task|File operation:/);
  assert.equal(compacted.length, entries.length + 1);
});
