import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createCodexImportTestRoot,
  createVisibleCodexRecords,
  writeCodexRollout,
} from "./codex-import-test-support.mjs";

const jiti = createJiti(import.meta.url);
const {
  CodexImportError,
  convertCodexRollout,
  inspectCodexRollout,
  serializeConvertedPiSession,
  validateConvertedPiSessionData,
  validateIsolatedResponsesReplay,
  validateResponsesReplay,
} = await jiti.import("./codex-import/index.ts");

/**
 * Convert one synthetic top-level rollout.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function convertFixture(fixture, threadId, records) {
  const rolloutPath = join(fixture.codexHome, "sessions", `${threadId}.jsonl`);
  writeCodexRollout(rolloutPath, records);
  const inspection = await inspectCodexRollout({
    threadId,
    rolloutPath,
    sqliteSource: "vscode",
    sqliteThreadSource: "user",
  });
  return convertCodexRollout({
    candidate: {
      id: threadId,
      name: "Synthetic imported session",
      archived: false,
      sourceKind: "root",
      rolloutPath,
    },
    inspection,
    snapshotPath: rolloutPath,
    targetCwd: fixture.workspace,
    sourceVersion: "fixture-version",
  });
}

test("imports visible history while removing hidden user context and provider continuation state", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000010";
  const conversion = await convertFixture(
    fixture,
    threadId,
    createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace),
  );
  const jsonl = serializeConvertedPiSession(conversion);

  assert.match(jsonl, /VISIBLE_USER_REQUEST/);
  assert.match(jsonl, /VISIBLE_ASSISTANT_PROGRESS/);
  assert.match(jsonl, /VISIBLE_THINKING_SUMMARY/);
  assert.match(jsonl, /VISIBLE_TOOL_OUTPUT/);
  assert.match(jsonl, /VISIBLE_FINAL_ANSWER/);
  assert.doesNotMatch(jsonl, /PRIVATE_DEVELOPER_CONTEXT/);
  assert.doesNotMatch(jsonl, /PRIVATE_CANONICAL_USER_CONTEXT/);
  assert.doesNotMatch(jsonl, /PRIVATE_REASONING_STATE/);
  assert.doesNotMatch(jsonl, /PRIVATE_TEXT_SIGNATURE/);
  assert.doesNotMatch(jsonl, /PRIVATE_RESPONSE_ID/);
  assert.equal(conversion.header.version, 3);
  assert.equal(conversion.header.cwd, fixture.workspace);
  const importedToolName = conversion.entries
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .flatMap((entry) => entry.message.content)
    .find((block) => block.type === "toolCall")?.name;
  assert.match(importedToolName, /^codex_[a-f0-9]{10}_read$/);

  const validation = validateConvertedPiSessionData(conversion);
  assert.equal(validation.toolCallCount, 1);
  assert.equal(validation.toolResultCount, 1);
  await validateResponsesReplay(conversion);
  await validateIsolatedResponsesReplay(conversion);
});

test("converts only the SQLite-selected session_meta segment", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-00000000001a";
  const otherId = "01900000-0000-7000-8000-00000000001b";
  const selected = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace);
  const other = JSON.parse(JSON.stringify(
    createVisibleCodexRecords(otherId, fixture.workspace, fixture.workspace),
  ).replaceAll("VISIBLE_", "OTHER_THREAD_SECRET_"));

  const conversion = await convertFixture(fixture, threadId, [...other, ...selected, ...other]);
  const jsonl = serializeConvertedPiSession(conversion);
  assert.match(jsonl, /VISIBLE_USER_REQUEST/);
  assert.doesNotMatch(jsonl, /OTHER_THREAD_SECRET/);
});

test("fails closed when canonical user context has no explicit visible user event", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000011";
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace)
    .filter((record) => !(record.type === "event_msg" && record.payload?.type === "user_message"));

  await assert.rejects(
    () => convertFixture(fixture, threadId, records),
    (error) => error instanceof CodexImportError && error.code === "NO_VISIBLE_USER_MESSAGE",
  );
});

test("conversion entry rejects subagents and guardians even if a caller selects them", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000012";
  const rolloutPath = join(fixture.codexHome, "sessions", "subagent.jsonl");
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace, {
    source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
    threadSource: "subagent",
  });
  writeCodexRollout(rolloutPath, records);
  const inspection = await inspectCodexRollout({
    threadId,
    rolloutPath,
    sqliteSource: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent" } } }),
    sqliteThreadSource: "subagent",
  });

  await assert.rejects(
    () => convertCodexRollout({
      candidate: { id: threadId, name: "child", archived: false, sourceKind: "root", rolloutPath },
      inspection,
      snapshotPath: rolloutPath,
      targetCwd: fixture.workspace,
      sourceVersion: "fixture-version",
    }),
    (error) => error instanceof CodexImportError && error.code === "NON_ROOT_SESSION_REJECTED",
  );
});

test("closes parallel and interrupted tool calls before the next conversation message", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000013";
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace);
  const firstCallIndex = records.findIndex((record) => record.payload?.type === "function_call");
  const firstOutputIndex = records.findIndex((record) => record.payload?.type === "function_call_output");
  records.splice(firstCallIndex + 1, 0, {
    timestamp: "2026-01-01T00:00:02.250Z",
    type: "response_item",
    payload: { type: "function_call", call_id: "call-two", name: "read", arguments: "{}" },
  });
  records.splice(firstOutputIndex + 2, 0, {
    timestamp: "2026-01-01T00:00:02.350Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "NEXT_MESSAGE" }] },
  });

  const conversion = await convertFixture(fixture, threadId, records);
  const validation = validateConvertedPiSessionData(conversion);
  assert.equal(validation.toolCallCount, 2);
  assert.equal(validation.toolResultCount, 2);
  assert.equal(validation.syntheticToolResultCount, 1);
  assert.ok(conversion.warnings.some((warning) => warning.code === "SYNTHETIC_TOOL_RESULT"));
  await validateResponsesReplay(conversion);
});

test("normalizes colliding call IDs without creating replay duplicates", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000014";
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace);
  const outputIndex = records.findIndex((record) => record.payload?.type === "function_call_output");
  records.splice(outputIndex + 1, 0,
    {
      timestamp: "2026-01-01T00:00:02.400Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "call?one", name: "read", arguments: "{}" },
    },
    {
      timestamp: "2026-01-01T00:00:02.500Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call?one", output: "SECOND_OUTPUT" },
    },
  );

  const conversion = await convertFixture(fixture, threadId, records);
  const callIds = conversion.entries
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .flatMap((entry) => entry.message.content.filter((block) => block.type === "toolCall").map((block) => block.id));
  assert.equal(callIds.length, 2);
  assert.equal(new Set(callIds).size, 2);
  assert.ok(callIds.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)));
  await validateResponsesReplay(conversion);
});

test("preserves data images and creates paired portable history for tool-search and image calls", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000015";
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace, {
    userText: "IMAGE_REQUEST",
  });
  const userIndex = records.findIndex((record) => record.type === "event_msg" && record.payload?.type === "user_message");
  records[userIndex].payload.images = ["data:image/png;base64,QUJDRA=="];
  const finalIndex = records.findIndex((record) => record.payload?.phase === "final_answer");
  records.splice(finalIndex, 0,
    {
      timestamp: "2026-01-01T00:00:02.600Z",
      type: "response_item",
      payload: { type: "tool_search_call", call_id: "search-1", arguments: { query: "portable" }, status: "completed" },
    },
    {
      timestamp: "2026-01-01T00:00:02.700Z",
      type: "response_item",
      payload: { type: "tool_search_output", call_id: "search-1", tools: [{ name: "read" }], status: "completed" },
    },
    {
      timestamp: "2026-01-01T00:00:02.800Z",
      type: "response_item",
      payload: { type: "image_generation_call", id: "image-1", result: "data:image/png;base64,QUJDRA==", status: "completed" },
    },
  );

  const conversion = await convertFixture(fixture, threadId, records);
  const jsonl = serializeConvertedPiSession(conversion);
  assert.match(jsonl, /\"type\":\"image\"/);
  const validation = validateConvertedPiSessionData(conversion);
  assert.equal(validation.toolCallCount, 3);
  assert.equal(validation.toolResultCount, 3);
  await validateResponsesReplay(conversion);
});
