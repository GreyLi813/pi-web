import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { Message, Model, StopReason } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { CodexImportError } from "./errors";
import {
  projectImportedCodexProviderHistory,
  readCodexImportRuntimePolicy,
} from "./runtime";
import type { ConvertedPiSession, PortableSessionValidation } from "./types";

const CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STOP_REASONS = new Set<StopReason>(["stop", "length", "toolUse", "error", "aborted"]);
const ASSISTANT_BLOCK_TYPES = new Set(["text", "thinking", "toolCall"]);
const PORTABLE_BLOCK_TYPES = new Set(["text", "image"]);

type JsonObject = Record<string, unknown>;

interface ToolPairState {
  calls: Map<string, string>;
  results: Set<string>;
  open: Map<string, string>;
  syntheticResultCount: number;
}

/**
 * Throw one structured validation failure without including transcript text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function fail(code: string, message: string): never {
  throw new CodexImportError(code, message);
}

/**
 * Return whether a retained object key represents provider-private continuation state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function isPrivateStateKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return normalized.includes("encrypted") || normalized.endsWith("signature")
    || normalized === "responseid" || normalized === "previousresponseid";
}

/**
 * Reject provider-private continuation keys anywhere in serialized session data.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertNoPrivateState(value: unknown): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current as JsonObject)) {
      if (isPrivateStateKey(key)) fail("PRIVATE_PROVIDER_STATE", "Converted history contains private provider continuation state");
      pending.push(child);
    }
  }
}

/**
 * Validate one Pi content array without reading or returning message bodies.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertContentArray(
  content: unknown,
  code: string,
  allowedTypes: ReadonlySet<string>,
): asserts content is JsonObject[] {
  if (!Array.isArray(content) || content.length === 0) fail(code, "A converted Pi message has no portable content");
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) fail(code, "A converted Pi content block is invalid");
    const object = block as JsonObject;
    if (typeof object.type !== "string" || !allowedTypes.has(object.type)) {
      fail(code, "A converted Pi content block type is invalid for its message role");
    }
    if (object.type === "text" && typeof object.text !== "string") fail(code, "A converted Pi text block is invalid");
    if (object.type === "thinking" && typeof object.thinking !== "string") fail(code, "A converted Pi thinking block is invalid");
    if (object.type === "image" && (typeof object.data !== "string" || typeof object.mimeType !== "string")) {
      fail(code, "A converted Pi image block is invalid");
    }
  }
}

/**
 * Validate an assistant message and register all newly opened calls.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateAssistantMessage(message: JsonObject, state: ToolPairState): void {
  if (state.open.size > 0) {
    fail("INVALID_TOOL_ORDER", "An assistant message appears before all prior tool calls have results");
  }
  assertContentArray(message.content, "INVALID_ASSISTANT_CONTENT", ASSISTANT_BLOCK_TYPES);
  if (!STOP_REASONS.has(message.stopReason as StopReason)) {
    fail("INVALID_STOP_REASON", "A converted assistant message has an unsupported stopReason");
  }
  const calls = message.content.filter((block) => block.type === "toolCall");
  if (calls.length > 0 && message.stopReason !== "toolUse") {
    fail("INVALID_TOOL_STOP_REASON", "An assistant message containing tool calls must stop with toolUse");
  }
  if (calls.length === 0 && message.stopReason === "toolUse") {
    fail("INVALID_TOOL_STOP_REASON", "An assistant message without tool calls cannot stop with toolUse");
  }
  for (const call of calls) {
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof call.name === "string" ? call.name : "";
    if (!CALL_ID_RE.test(id)) fail("INVALID_TOOL_CALL_ID", "A converted tool call ID is not portable");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)
      || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      fail("INVALID_TOOL_CALL", "A converted tool call is malformed");
    }
    if (state.calls.has(id)) fail("DUPLICATE_TOOL_CALL", "A converted tool call ID is duplicated");
    state.calls.set(id, name);
    state.open.set(id, name);
  }
}

/**
 * Validate one tool result against the currently open call set.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateToolResult(message: JsonObject, state: ToolPairState): void {
  const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  const expectedName = state.open.get(callId);
  if (!expectedName) fail("ORPHAN_TOOL_RESULT", "A converted tool result has no currently open call");
  if (state.results.has(callId)) fail("DUPLICATE_TOOL_RESULT", "A converted tool call has more than one result");
  if (message.toolName !== expectedName) fail("TOOL_NAME_MISMATCH", "A converted tool result changed its call name");
  if (typeof message.isError !== "boolean") fail("INVALID_TOOL_RESULT", "A converted tool result lacks an error state");
  assertContentArray(message.content, "INVALID_TOOL_RESULT_CONTENT", PORTABLE_BLOCK_TYPES);
  const details = message.details as JsonObject | undefined;
  const marker = details?.codexImport as JsonObject | undefined;
  if (marker?.synthetic === true) {
    if (message.isError !== true) fail("INVALID_SYNTHETIC_TOOL_RESULT", "A synthetic tool result must be an error");
    state.syntheticResultCount += 1;
  }
  state.results.add(callId);
  state.open.delete(callId);
}

/**
 * Validate one standard Pi message and update call/result state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateMessageEntry(entry: SessionEntry, state: ToolPairState): void {
  if (entry.type !== "message") return;
  const message = entry.message as unknown as JsonObject;
  if (!Number.isFinite(message.timestamp)) fail("INVALID_MESSAGE_TIMESTAMP", "A converted Pi message timestamp is invalid");
  if (message.role === "user") {
    if (state.open.size > 0) fail("INVALID_TOOL_ORDER", "A user message appears before all prior tool calls have results");
    if (typeof message.content !== "string") {
      assertContentArray(message.content, "INVALID_USER_CONTENT", PORTABLE_BLOCK_TYPES);
    }
  } else if (message.role === "assistant") {
    validateAssistantMessage(message, state);
  } else if (message.role === "toolResult") {
    validateToolResult(message, state);
  } else {
    fail("INVALID_MESSAGE_ROLE", "A converted Pi message has an unsupported role");
  }
}

/**
 * Validate header, linear chain, unique IDs, stop reasons, and exact tool pairing.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function validateConvertedPiSessionData(conversion: ConvertedPiSession): PortableSessionValidation {
  const { header, entries } = conversion;
  if (header.type !== "session" || header.version !== 3 || !header.id || !header.cwd
    || Number.isNaN(Date.parse(header.timestamp))) {
    fail("INVALID_PI_HEADER", "Converted data does not contain a valid Pi v3 session header");
  }
  if (!Array.isArray(entries) || entries.length === 0) fail("EMPTY_PI_SESSION", "Converted Pi session has no entries");
  assertNoPrivateState([header, ...entries]);

  const ids = new Set<string>();
  const state: ToolPairState = {
    calls: new Map(),
    results: new Set(),
    open: new Map(),
    syntheticResultCount: 0,
  };
  let parentId: string | null = null;
  let messageCount = 0;
  let visibleUserCount = 0;
  let hasSessionInfo = false;
  let hasProvenance = false;

  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) fail("DUPLICATE_PI_ENTRY_ID", "Converted Pi entry IDs must be non-empty and unique");
    if (entry.parentId !== parentId) fail("INVALID_PI_TREE", "Converted Pi entries do not form one linear parent chain");
    if (Number.isNaN(Date.parse(entry.timestamp))) fail("INVALID_PI_ENTRY_TIMESTAMP", "A converted Pi entry timestamp is invalid");
    ids.add(entry.id);
    parentId = entry.id;
    if (entry.type === "session_info") hasSessionInfo = true;
    if (entry.type === "custom" && entry.customType === "codex-import") hasProvenance = true;
    if (entry.type === "message") {
      messageCount += 1;
      if (entry.message.role === "user") visibleUserCount += 1;
      validateMessageEntry(entry, state);
    }
  }
  if (!hasSessionInfo || !hasProvenance) fail("MISSING_IMPORT_METADATA", "Converted Pi session lacks import metadata");
  if (visibleUserCount === 0) fail("NO_VISIBLE_USER_MESSAGE", "Converted Pi session has no explicit visible user message");
  if (state.open.size > 0) fail("MISSING_TOOL_RESULT", "One or more converted tool calls have no result");
  if (state.calls.size !== state.results.size) fail("INCOMPLETE_TOOL_PAIRS", "Converted tool calls and results are not one-to-one");

  return {
    toolCallCount: state.calls.size,
    toolResultCount: state.results.size,
    syntheticToolResultCount: state.syntheticResultCount,
    messageCount,
  };
}

/**
 * Build the portable model descriptor used only for local Responses replay validation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createReplayModel(messages: Message[]): Model<"openai-codex-responses"> {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  const modelId = assistant?.role === "assistant" && assistant.model ? assistant.model : "codex-imported";
  return {
    id: modelId,
    name: modelId,
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
  };
}

/**
 * Validate call/result ordering after Pi context projection and Responses conversion.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateReplayItems(items: unknown[], expectedCalls: number, expectedResults: number): void {
  const calls = new Set<string>();
  const results = new Set<string>();
  const open = new Set<string>();
  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as JsonObject;
    const isConversation = item.role === "user" || (item.type === "message" && item.role === "assistant");
    if (isConversation && open.size > 0) {
      fail("INVALID_REPLAY_ORDER", "Responses replay places a conversation message before pending tool outputs");
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!CALL_ID_RE.test(callId) || calls.has(callId)) {
        fail("INVALID_REPLAY_CALL_ID", "Responses replay produced an invalid or duplicate call ID");
      }
      calls.add(callId);
      open.add(callId);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!open.has(callId) || results.has(callId)) {
        fail("INVALID_REPLAY_RESULT", "Responses replay produced an orphan or duplicate tool result");
      }
      results.add(callId);
      open.delete(callId);
    }
  }
  if (open.size > 0 || calls.size !== expectedCalls || results.size !== expectedResults) {
    fail("INCOMPLETE_RESPONSES_REPLAY", "Responses replay did not preserve every converted tool pair");
  }
}

/**
 * Count tool pairs in the active, compaction-aware Pi context.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function countContextToolPairs(messages: Message[]): { calls: number; results: number } {
  let calls = 0;
  let results = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      calls += message.content.filter((block) => block.type === "toolCall").length;
    } else if (message.role === "toolResult") {
      results += 1;
    }
  }
  return { calls, results };
}

/**
 * Validate replay through Pi buildSessionContext and the shared Responses converter.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function validateResponsesReplay(conversion: ConvertedPiSession): Promise<void> {
  validateConvertedPiSessionData(conversion);
  let messages: Message[];
  try {
    messages = buildSessionContext(conversion.entries).messages as Message[];
  } catch {
    fail("PI_CONTEXT_BUILD_FAILED", "Pi could not build context from the converted session");
  }
  const expected = countContextToolPairs(messages);
  if (expected.calls !== expected.results) {
    fail("INCOMPLETE_CONTEXT_TOOL_PAIRS", "Pi active context contains incomplete tool pairs");
  }
  let replay: unknown[];
  try {
    replay = convertResponsesMessages(
      createReplayModel(messages),
      { systemPrompt: "", messages, tools: [] },
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    ) as unknown[];
  } catch {
    fail("RESPONSES_REPLAY_FAILED", "The shared Responses converter rejected the converted session");
  }
  validateReplayItems(replay, expected.calls, expected.results);
}

/**
 * Prove that provider-bound history contains no executable Codex tool protocol.
 * The original Pi JSONL still passes the full call/result replay validation above.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function validateIsolatedResponsesReplay(conversion: ConvertedPiSession): Promise<void> {
  validateConvertedPiSessionData(conversion);
  const policy = readCodexImportRuntimePolicy(conversion.entries);
  if (!policy) fail("MISSING_IMPORT_RUNTIME_POLICY", "Converted history lacks a valid runtime isolation marker");
  let messages: Message[];
  try {
    const context = buildSessionContext(conversion.entries).messages as Message[];
    messages = projectImportedCodexProviderHistory(context, policy);
  } catch {
    fail("PI_CONTEXT_BUILD_FAILED", "Pi could not build isolated context from the converted session");
  }
  const remaining = countContextToolPairs(messages);
  if (remaining.calls !== 0 || remaining.results !== 0) {
    fail("LEGACY_TOOL_PROTOCOL_RETAINED", "Provider history still contains executable imported tool records");
  }
  let replay: unknown[];
  try {
    replay = convertResponsesMessages(
      createReplayModel(messages),
      { systemPrompt: "", messages, tools: [] },
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    ) as unknown[];
  } catch {
    fail("ISOLATED_RESPONSES_REPLAY_FAILED", "The shared Responses converter rejected isolated history");
  }
  validateReplayItems(replay, 0, 0);
}
