import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  installCodexImportProviderProjection,
  projectImportedCodexProviderHistory,
  readCodexImportRuntimePolicy,
} = await jiti.import("./codex-import/index.ts");

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Build the canonical early provenance marker written by the converter.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function importedEntries(threadId) {
  return [
    { type: "session_info", id: "name", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", name: "Imported" },
    {
      type: "custom",
      id: "marker",
      parentId: "name",
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "codex-import",
      data: {
        version: 1,
        sourceThreadId: threadId,
        sourceVersion: "bounded-source-version",
        sourceKind: "root",
      },
    },
  ];
}

/**
 * Build one portable assistant message for runtime projection tests.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assistant(content, stopReason = "toolUse") {
  return {
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: structuredClone(ZERO_USAGE),
    stopReason,
    timestamp: 1,
  };
}

test("recognizes only a canonical Codex import marker and selects Pi's four default tools", () => {
  const threadId = "01900000-0000-7000-8000-000000000099";
  const policy = readCodexImportRuntimePolicy(importedEntries(threadId));
  assert.ok(policy);
  assert.deepEqual(policy.initialToolNames, ["read", "bash", "edit", "write"]);
  assert.equal(
    policy.toolNamePrefix,
    `codex_${createHash("sha256").update(threadId).digest("hex").slice(0, 10)}_`,
  );

  const misplaced = importedEntries(threadId).toReversed();
  const malformed = importedEntries(threadId);
  malformed[1] = { ...malformed[1], parentId: "wrong" };
  assert.equal(readCodexImportRuntimePolicy(misplaced), undefined);
  assert.equal(readCodexImportRuntimePolicy(malformed), undefined);
  assert.equal(readCodexImportRuntimePolicy([{
    type: "message",
    id: "ordinary",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: assistant([{ type: "toolCall", id: "same-shape", name: "codex_deadbeef00_read", arguments: {} }]),
  }]), undefined);
});

test("keeps imported tool records on disk but removes their native protocol from provider history", () => {
  const threadId = "01900000-0000-7000-8000-000000000098";
  const policy = readCodexImportRuntimePolicy(importedEntries(threadId));
  assert.ok(policy);
  const importedName = `${policy.toolNamePrefix}read`;
  const messages = [
    { role: "user", content: "Inspect the project", timestamp: 0 },
    assistant([
      { type: "text", text: "Checking the old environment." },
      { type: "toolCall", id: "legacy-call", name: importedName, arguments: { path: "old.txt" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "legacy-call",
      toolName: importedName,
      content: [{ type: "text", text: "OLD_TOOL_OUTPUT" }],
      isError: false,
      timestamp: 2,
    },
    assistant([{ type: "text", text: "Old inspection finished." }], "stop"),
    assistant([{ type: "toolCall", id: "current-call", name: "read", arguments: { path: "current.txt" } }]),
    {
      role: "toolResult",
      toolCallId: "current-call",
      toolName: "read",
      content: [{ type: "text", text: "CURRENT_TOOL_OUTPUT" }],
      isError: false,
      timestamp: 3,
    },
  ];
  const before = structuredClone(messages);

  const projected = projectImportedCodexProviderHistory(messages, policy);
  assert.deepEqual(messages, before, "provider projection mutated persisted history");
  assert.ok(projected.every((message) => message.role !== "assistant"
    || message.content.every((block) => block.type !== "toolCall" || block.name !== importedName)));
  assert.ok(projected.every((message) => message.role !== "toolResult" || message.toolName !== importedName));
  assert.ok(projected.some((message) => JSON.stringify(message).includes("old.txt")));
  assert.ok(projected.some((message) => JSON.stringify(message).includes("OLD_TOOL_OUTPUT")));

  const currentAssistant = projected.find((message) => message.role === "assistant"
    && message.content.some((block) => block.type === "toolCall" && block.id === "current-call"));
  const currentResult = projected.find((message) => message.role === "toolResult"
    && message.toolCallId === "current-call");
  assert.ok(currentAssistant, "a new Pi tool call was incorrectly isolated");
  assert.ok(currentResult, "a new Pi tool result was incorrectly isolated");

  const isolatedAssistant = projected.find((message) => message.role === "assistant"
    && JSON.stringify(message).includes("legacy-call"));
  assert.equal(isolatedAssistant.stopReason, "stop");
});

test("installs isolation at conversion and final provider-stream boundaries", async () => {
  const threadId = "01900000-0000-7000-8000-000000000096";
  const policy = readCodexImportRuntimePolicy(importedEntries(threadId));
  assert.ok(policy);
  const importedName = `${policy.toolNamePrefix}read`;
  const messages = [
    assistant([{ type: "toolCall", id: "legacy", name: importedName, arguments: {} }]),
    { role: "toolResult", toolCallId: "legacy", toolName: importedName, content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 },
  ];
  let streamedMessages;
  const streamResult = { kind: "test-stream" };
  const agent = {
    convertToLlm: (input) => input,
    streamFunction: (_model, context) => {
      streamedMessages = context.messages;
      return streamResult;
    },
  };
  installCodexImportProviderProjection(agent, policy);

  const converted = await agent.convertToLlm(messages);
  assert.ok(converted.every((message) => message.role !== "toolResult"));
  assert.ok(converted.every((message) => message.role !== "assistant"
    || message.content.every((block) => block.type !== "toolCall")));
  assert.equal(agent.streamFunction({}, { systemPrompt: "", messages, tools: [] }), streamResult);
  assert.ok(streamedMessages.every((message) => message.role !== "toolResult"));
  assert.ok(streamedMessages.every((message) => message.role !== "assistant"
    || message.content.every((block) => block.type !== "toolCall")));
});

test("isolates every call in a mixed historical assistant turn to keep provider ordering valid", () => {
  const threadId = "01900000-0000-7000-8000-000000000097";
  const policy = readCodexImportRuntimePolicy(importedEntries(threadId));
  assert.ok(policy);
  const messages = [
    assistant([
      { type: "toolCall", id: "legacy", name: `${policy.toolNamePrefix}read`, arguments: {} },
      { type: "toolCall", id: "mixed", name: "read", arguments: {} },
    ]),
    { role: "toolResult", toolCallId: "legacy", toolName: `${policy.toolNamePrefix}read`, content: [{ type: "text", text: "legacy" }], isError: false, timestamp: 2 },
    { role: "toolResult", toolCallId: "mixed", toolName: "read", content: [{ type: "text", text: "mixed" }], isError: false, timestamp: 3 },
  ];

  const projected = projectImportedCodexProviderHistory(messages, policy);
  assert.ok(projected.every((message) => message.role !== "assistant"
    || message.content.every((block) => block.type !== "toolCall")));
  assert.ok(projected.every((message) => message.role !== "toolResult"));
  assert.ok(JSON.stringify(projected).includes("legacy"));
  assert.ok(JSON.stringify(projected).includes("mixed"));
});
