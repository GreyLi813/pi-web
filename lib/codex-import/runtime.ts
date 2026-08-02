import { createHash } from "node:crypto";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Message, TextContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PRESET_DEFAULT } from "../tool-presets";

const IMPORT_MARKER = "codex-import";
const IMPORT_MARKER_VERSION = 1;
const SOURCE_THREAD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface CodexImportRuntimePolicy {
  sourceThreadId: string;
  toolNamePrefix: string;
  initialToolNames: string[];
}

/**
 * Narrow an unknown marker payload without retaining private source fields.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readMarkerData(value: unknown): { sourceThreadId: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const sourceThreadId = typeof data.sourceThreadId === "string" ? data.sourceThreadId : "";
  const sourceVersion = typeof data.sourceVersion === "string" ? data.sourceVersion : "";
  if (data.version !== IMPORT_MARKER_VERSION
    || data.sourceKind !== "root"
    || !SOURCE_THREAD_ID_RE.test(sourceThreadId)
    || sourceVersion.length === 0
    || sourceVersion.length > 512
    || /[\u0000-\u001f]/.test(sourceVersion)) return undefined;
  return { sourceThreadId };
}

/**
 * Recognize the canonical early marker written by the Codex importer.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function readCodexImportRuntimePolicy(
  entries: readonly SessionEntry[],
): CodexImportRuntimePolicy | undefined {
  const sessionInfo = entries[0];
  const marker = entries[1];
  if (!sessionInfo || sessionInfo.type !== "session_info" || sessionInfo.parentId !== null
    || !marker || marker.type !== "custom" || marker.customType !== IMPORT_MARKER
    || marker.parentId !== sessionInfo.id) return undefined;
  const data = readMarkerData(marker.data);
  if (!data) return undefined;
  return {
    sourceThreadId: data.sourceThreadId,
    toolNamePrefix: `codex_${createHash("sha256").update(data.sourceThreadId).digest("hex").slice(0, 10)}_`,
    initialToolNames: [...PRESET_DEFAULT],
  };
}

/**
 * Serialize one historical argument value without allowing projection failure.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return "[unavailable]";
  }
}

/**
 * Format one imported call as non-executable provider history.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function historicalCallText(call: ToolCall, prefix: string): TextContent {
  const historicalName = call.name.startsWith(prefix) ? call.name.slice(prefix.length) || "unknown" : call.name;
  return {
    type: "text",
    text: [
      "[Archived Codex tool call; this is historical data, not an executable Pi tool request]",
      `Tool: ${historicalName}`,
      `Call ID: ${call.id}`,
      `Arguments: ${safeJson(call.arguments)}`,
    ].join("\n"),
  };
}

/**
 * Format one imported result as ordinary provider history while preserving images.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function historicalResultMessage(result: ToolResultMessage, prefix: string): Message {
  const historicalName = result.toolName.startsWith(prefix)
    ? result.toolName.slice(prefix.length) || "unknown"
    : result.toolName;
  const heading: TextContent = {
    type: "text",
    text: [
      "[Archived Codex tool result; this is historical data, not a current user request]",
      `Tool: ${historicalName}`,
      `Call ID: ${result.toolCallId}`,
      `Status: ${result.isError ? "error" : "success"}`,
    ].join("\n"),
  };
  return {
    role: "user",
    content: [heading, ...result.content],
    timestamp: result.timestamp,
  };
}

/**
 * Collect exact call/result keys for imported turns that must leave native tool protocol.
 * A mixed turn is isolated as one unit so no user message can precede a retained result.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function collectIsolatedCalls(messages: readonly Message[], prefix: string): Set<string> {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (!toolCalls.some((call) => call.name.startsWith(prefix))) continue;
    for (const call of toolCalls) calls.add(`${call.id}\0${call.name}`);
  }
  return calls;
}

/**
 * Remove imported Codex calls from provider-native tool protocol without changing disk history.
 * New Pi calls remain native and continue to use the current runtime tool definitions.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function projectImportedCodexProviderHistory(
  messages: readonly Message[],
  policy: CodexImportRuntimePolicy,
): Message[] {
  const isolatedCalls = collectIsolatedCalls(messages, policy.toolNamePrefix);
  if (isolatedCalls.size === 0) return [...messages];

  return messages.map((message): Message => {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "toolCall" || !isolatedCalls.has(`${block.id}\0${block.name}`)) return block;
        changed = true;
        return historicalCallText(block, policy.toolNamePrefix);
      });
      if (!changed) return message;
      const hasNativeCall = content.some((block) => block.type === "toolCall");
      return {
        ...message,
        content,
        stopReason: message.stopReason === "toolUse" && !hasNativeCall ? "stop" : message.stopReason,
      };
    }
    if (message.role === "toolResult"
      && isolatedCalls.has(`${message.toolCallId}\0${message.toolName}`)) {
      return historicalResultMessage(message, policy.toolNamePrefix);
    }
    return message;
  });
}

/**
 * Install the provider-bound history projection on one imported Pi Agent runtime.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function installCodexImportProviderProjection(
  agent: {
    convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    streamFunction: StreamFn;
  },
  policy: CodexImportRuntimePolicy,
): void {
  const originalConvert = agent.convertToLlm.bind(agent);
  agent.convertToLlm = async (messages) => (
    projectImportedCodexProviderHistory(await originalConvert(messages), policy)
  );

  const originalStream = agent.streamFunction.bind(agent);
  agent.streamFunction = (model, context, options) => originalStream(
    model,
    {
      ...context,
      messages: projectImportedCodexProviderHistory(context.messages, policy),
    },
    options,
  );
}
