import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Rebuild a transcript so its replayed system prompt is exactly `prompt`.
 *
 * pi-agent 0.87+ derives `AgentState.systemPrompt` from the transcript's
 * system messages (the state field is read-only). Replay joins the content of
 * every system message and patches sections by name, so forcing an exact
 * prompt means: keep the leading message's tool declarations, drop its
 * sections, and remove every later system message.
 */
export function withTranscriptSystemPrompt(
  messages: readonly AgentMessage[],
  prompt: string,
): AgentMessage[] {
  const first = messages[0];
  const head = first && first.role === "system"
    ? {
        role: "system" as const,
        content: prompt,
        ...(first.toolsAdded ? { toolsAdded: first.toolsAdded } : {}),
        ...(first.toolsRemoved ? { toolsRemoved: first.toolsRemoved } : {}),
        timestamp: first.timestamp,
      }
    : { role: "system" as const, content: prompt, timestamp: Date.now() };
  return [head, ...messages.filter((message) => message.role !== "system")];
}