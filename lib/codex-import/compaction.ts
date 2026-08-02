import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { open, rename, rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { CodexImportError } from "./errors";
import { assertNoLinkedPathComponents, ensureSecureDirectory, isPathWithin, openRegularFileNoFollow } from "./filesystem";
import type {
  CodexSemanticHint,
  CompactionCheckpointRecord,
  CompactionCheckpointStore,
  CompressionModelDescriptor,
  SemanticCompactionPlan,
  SemanticFrame,
  SemanticSummaryCall,
  SemanticSummaryChunk,
  SemanticSummaryResult,
  SemanticUnit,
  SummaryCallResponse,
} from "./types";

const COMPACTION_ALGORITHM_VERSION = 2;
const CHECKPOINT_FORMAT_VERSION = 2;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const MIN_SAFE_INPUT_TOKENS = 256;
// Pi 0.82.1 fixed system + initial/update prompts are under 400 estimated tokens; keep a 2x envelope.
const DEFAULT_SUMMARY_PROMPT_OVERHEAD_TOKENS = 768;
const MERGE_CHILD_WRAPPER_TOKENS = 64;
const MESSAGE_WRAPPER_TOKENS = 8;
const MODEL_SUMMARY_RESERVE_RATIO = 0.7;
const COVERAGE_MANIFEST_RESERVE_RATIO = 0.38;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const SUMMARY_TEMPLATE = `Create a concise continuation checkpoint. Preserve the original request, constraints, decisions,
exact identifiers, tool outcomes, file operations, unfinished work, and next steps. Do not invent facts.
When child checkpoints are supplied, merge them in source order without dropping or duplicating coverage.`;
const PATH_ARGUMENT_KEYS = new Set([
  "path",
  "file",
  "filePath",
  "file_path",
  "target",
  "source",
  "destination",
  "oldPath",
  "newPath",
  "cwd",
]);
const READ_TOOL_RE = /^(read|cat|head|tail|grep|rg|find|glob|ls|list|stat|inspect)/i;
const WRITE_TOOL_RE = /^(write|edit|patch|apply|delete|remove|move|rename|mkdir|touch)/i;

export interface PlanSemanticCompactionOptions {
  entries: SessionEntry[];
  currentModel: CompressionModelDescriptor;
  availableModels: CompressionModelDescriptor[];
  sourceVersion: string;
  semanticHints?: CodexSemanticHint[];
  keepRecentTokens?: number;
  reserveTokens?: number;
  summaryReserveTokens?: number;
  safetyTokens?: number;
  templateTokens?: number;
  previousSummary?: string;
  crossProviderConfirmed?: boolean;
  crossProviderModel?: { provider: string; modelId: string };
}

export interface SemanticSummaryInput {
  messages: AgentMessage[];
  childSummaries: Array<{ callId: string; text: string; entryIds: string[]; hash: string }>;
  previousSummary?: string;
  continuity?: SemanticSummaryChunk["continuity"];
  coverage: {
    entryIds: string[];
    inputHash: string;
    toolCallCount: number;
    fileOperations: string[];
  };
  model: CompressionModelDescriptor;
  reserveTokens: number;
  instructions: string;
}

export type SemanticSummarizer = (
  call: SemanticSummaryCall,
  input: SemanticSummaryInput,
) => Promise<SummaryCallResponse>;

export interface ExecuteSemanticCompactionOptions {
  plan: SemanticCompactionPlan;
  entries: SessionEntry[];
  checkpointStore: CompactionCheckpointStore;
  summarize: SemanticSummarizer;
}

export interface CreateFileCompactionCheckpointStoreOptions {
  agentDir: string;
  threadId: string;
  sourceVersion: string;
  planHash: string;
}

export interface ApplySemanticCompactionOptions {
  entries: SessionEntry[];
  plan: SemanticCompactionPlan;
  result: SemanticSummaryResult;
}

interface RuntimeSemanticCompactionPlan extends SemanticCompactionPlan {
  sourceHash: string;
  previousSummary?: string;
  previousSummaryHash: string;
  compactionEntryId: string;
  targetProvider: string;
  targetModelId: string;
}

interface EntryFacts {
  entry: SessionEntry;
  messages: AgentMessage[];
  tokens: number;
  toolCallIds: string[];
  toolResultId?: string;
  fileOperations: string[];
}

interface UnitBuild {
  unit: SemanticUnit;
  facts: EntryFacts[];
}

interface PlanningBudget {
  reserveTokens: number;
  safetyTokens: number;
  templateTokens: number;
  previousSummaryTokens: number;
  keepRecentTokens: number;
  finalKeptCapacity: number;
}

interface CandidatePlanParts {
  model: CompressionModelDescriptor;
  safeInputCapacity: number;
  keptUnits: SemanticUnit[];
  summaryUnits: SemanticUnit[];
  leafChunks: SemanticSummaryChunk[];
  calls: SemanticSummaryCall[];
  mode: "single" | "hierarchical";
}

interface MergeNode {
  id: string;
  entryIds: string[];
  unitIds: string[];
  estimatedOutputTokens: number;
}

interface CompletedCall {
  call: SemanticSummaryCall;
  record: CompactionCheckpointRecord;
  hash: string;
}

/**
 * Hash text with SHA-256 for stable plan, source, and checkpoint identities.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Convert arbitrary JSON-like input into a stable, hashable representation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (typeof record[key] !== "undefined" && typeof record[key] !== "function") {
        normalized[key] = stableValue(record[key], seen);
      }
    }
    seen.delete(value);
    return normalized;
  }
  return String(value);
}

/**
 * Serialize data deterministically before hashing it.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * Hash a JSON-like object deterministically.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function hashObject(value: unknown): string {
  return hashText(stableStringify(value));
}

/**
 * Build a valid Pi user message solely for Pi token estimation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function textEstimationMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

/**
 * Estimate arbitrary text through Pi's estimateTokens implementation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function estimateText(text: string): number {
  return estimateTokens(textEstimationMessage(text));
}

/**
 * Project a session entry into the messages relevant to import-time compaction.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function messagesFromEntry(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "message") return [entry.message];
  if (entry.type === "custom_message") {
    return [{ role: "custom", content: entry.content ?? [], timestamp: Date.parse(entry.timestamp) } as AgentMessage];
  }
  if (entry.type === "branch_summary") {
    return [{ role: "branchSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) } as AgentMessage];
  }
  if (entry.type === "compaction") {
    return [{ role: "compactionSummary", summary: entry.summary, timestamp: Date.parse(entry.timestamp) } as AgentMessage];
  }
  return [];
}

/**
 * Estimate messages with Pi and safely account for malformed imported records.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function estimateMessageList(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    try {
      total += estimateTokens(message) + MESSAGE_WRAPPER_TOKENS;
    } catch {
      total += estimateText(stableStringify(message)) + MESSAGE_WRAPPER_TOKENS;
    }
  }
  return total;
}

/**
 * Read tool calls from one Pi assistant entry without changing the source.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function toolCallsFromEntry(entry: SessionEntry): Array<{ id: string; name: string; arguments: unknown }> {
  if (entry.type !== "message" || entry.message.role !== "assistant") return [];
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const block of content) {
    if (block.type !== "toolCall") continue;
    const raw = block as unknown as Record<string, unknown>;
    const id = String(raw.id ?? raw.toolCallId ?? "");
    if (!id) continue;
    calls.push({
      id,
      name: String(raw.name ?? raw.toolName ?? "tool"),
      arguments: raw.arguments ?? raw.input ?? {},
    });
  }
  return calls;
}

/**
 * Read a tool-result call ID from one entry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function toolResultIdFromEntry(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
  const id = (entry.message as unknown as Record<string, unknown>).toolCallId;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Collect path-shaped values from tool arguments with a bounded iterative walk.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function collectToolPaths(argumentsValue: unknown): string[] {
  const paths = new Set<string>();
  const queue: Array<{ value: unknown; key: string; depth: number }> = [{ value: argumentsValue, key: "", depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 6 || current.value === null) continue;
    if (typeof current.value === "string") {
      if (PATH_ARGUMENT_KEYS.has(current.key) && current.value.trim()) paths.add(current.value.trim());
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) queue.push({ value: item, key: current.key, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value === "object") {
      for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
        queue.push({ value, key, depth: current.depth + 1 });
      }
    }
  }
  return [...paths].sort();
}

/**
 * Extract deterministic read/modified/other file-operation markers from an entry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function fileOperationsFromEntry(entry: SessionEntry): string[] {
  const operations = new Set<string>();
  for (const call of toolCallsFromEntry(entry)) {
    const semanticToolName = call.name.replace(/^codex_[a-f0-9]{10}_/i, "");
    const kind = READ_TOOL_RE.test(semanticToolName)
      ? "read"
      : WRITE_TOOL_RE.test(semanticToolName) ? "modified" : semanticToolName;
    for (const path of collectToolPaths(call.arguments)) operations.add(`${kind}:${path}`);
    const argumentsRecord = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
      ? call.arguments as Record<string, unknown>
      : {};
    if (/(?:^|_)(bash|shell|exec)(?:_|$)/i.test(semanticToolName)) {
      for (const key of ["command", "script", "cmd"]) {
        const command = argumentsRecord[key];
        if (typeof command === "string" && command.trim()) operations.add(`shell-command:${command.trim()}`);
      }
    }
    const patchValues = [argumentsRecord.patch, argumentsRecord.diff];
    if (/^(?:apply_)?patch$/i.test(semanticToolName)) patchValues.push(argumentsRecord.input);
    for (const patch of patchValues) {
      if (typeof patch !== "string") continue;
      for (const match of patch.matchAll(/(?:\*\*\* (?:Update|Add|Delete) File:|\*\*\* Move to:|[+-]{3}\s+(?:[ab]\/)?)([^\r\n]+)/g)) {
        if (match[1]?.trim() && match[1] !== "/dev/null") operations.add(`modified:${match[1].trim()}`);
      }
    }
  }
  return [...operations].sort();
}

/**
 * Analyze every source entry once for token, tool, and file coverage.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function analyzeEntries(entries: SessionEntry[]): EntryFacts[] {
  const ids = new Set<string>();
  return entries.map((entry) => {
    if (!entry.id || ids.has(entry.id)) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Compaction source entry IDs must be unique and non-empty");
    }
    ids.add(entry.id);
    const messages = messagesFromEntry(entry);
    return {
      entry,
      messages,
      tokens: estimateMessageList(messages),
      toolCallIds: toolCallsFromEntry(entry).map((call) => call.id),
      toolResultId: toolResultIdFromEntry(entry),
      fileOperations: fileOperationsFromEntry(entry),
    };
  });
}

/**
 * Return the user-visible text in a message for continuity metadata.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function messageText(message: AgentMessage): string {
  const content = (message as unknown as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const value = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (value.type === "text" && typeof value.text === "string") return [value.text];
      if (value.type === "thinking" && typeof value.thinking === "string") return [value.thinking];
      return [];
    })
    .join("\n");
}

/**
 * Detect an imported user request entry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function isUserRequest(fact: EntryFacts): boolean {
  return fact.entry.type === "message" && fact.entry.message.role === "user";
}

/**
 * Resolve a complete task/turn hint key for one entry ID.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function semanticHintKey(entryId: string, hints: CodexSemanticHint[]): string | undefined {
  const matches = hints.filter((hint) => hint.entryIds.includes(entryId) && (hint.kind === "task" || hint.kind === "turn"));
  if (matches.length > 1 && new Set(matches.map((hint) => hint.key)).size > 1) {
    throw new CodexImportError("COMPACTION_PLAN_INVALID", `Conflicting semantic hints cover entry ${entryId}`);
  }
  return matches[0]?.key;
}

/**
 * Decide whether a user entry starts a new indivisible semantic unit.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function startsNewUnit(current: EntryFacts[], next: EntryFacts, hints: CodexSemanticHint[]): boolean {
  if (current.length === 0 || !isUserRequest(next)) return false;
  const currentUsers = current.filter(isUserRequest);
  if (currentUsers.length === 0) return false;
  const currentKey = semanticHintKey(currentUsers.at(-1)!.entry.id, hints);
  const nextKey = semanticHintKey(next.entry.id, hints);
  return !currentKey || !nextKey || currentKey !== nextKey;
}

/**
 * Determine whether an assistant entry closes a reliable semantic phase.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function closesAssistantPhase(fact: EntryFacts, openToolCalls: Set<string>): boolean {
  if (fact.entry.type !== "message" || fact.entry.message.role !== "assistant" || openToolCalls.size > 0) return false;
  const stopReason = String((fact.entry.message as unknown as Record<string, unknown>).stopReason ?? "");
  if (fact.toolCallIds.length === 0 && stopReason !== "toolUse") return true;
  const text = fact.messages.map(messageText).join("\n");
  return /(^|\n)#{1,6}\s+\S|\b(design|implementation|tests?|function|class|file)\b/i.test(text);
}

/**
 * Split one unit into frames only after closed assistant phases or closed tool cycles.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createFrames(facts: EntryFacts[], unitIndex: number): SemanticFrame[] {
  const frames: SemanticFrame[] = [];
  const openToolCalls = new Set<string>();
  let frameFacts: EntryFacts[] = [];
  const flush = (safeBoundary: boolean): void => {
    if (frameFacts.length === 0) return;
    const messages = frameFacts.flatMap((fact) => fact.messages);
    frames.push({
      id: `unit-${unitIndex + 1}-frame-${frames.length + 1}`,
      entryIds: frameFacts.map((fact) => fact.entry.id),
      messages,
      estimatedTokens: estimateMessageList(messages),
      safeBoundary,
    });
    frameFacts = [];
  };

  for (const fact of facts) {
    frameFacts.push(fact);
    for (const callId of fact.toolCallIds) openToolCalls.add(callId);
    const closedToolCycle = Boolean(fact.toolResultId && openToolCalls.delete(fact.toolResultId) && openToolCalls.size === 0);
    if (closedToolCycle || closesAssistantPhase(fact, openToolCalls)) flush(true);
  }
  flush(openToolCalls.size === 0);
  if (frames.length > 1 && frames.at(-1)!.messages.length === 0) {
    const tail = frames.pop()!;
    frames.at(-1)!.entryIds.push(...tail.entryIds);
  }
  return frames;
}

/**
 * Build one semantic unit and verify its complete assistant/tool/result lifecycle.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createUnit(facts: EntryFacts[], unitIndex: number, hints: CodexSemanticHint[]): UnitBuild {
  const openToolCalls = new Set<string>();
  const seenToolCalls = new Set<string>();
  let orphanResult = false;
  let hasUser = false;
  let hasAssistant = false;
  for (const fact of facts) {
    if (isUserRequest(fact)) hasUser = true;
    if (fact.entry.type === "message" && fact.entry.message.role === "assistant") hasAssistant = true;
    for (const callId of fact.toolCallIds) {
      if (seenToolCalls.has(callId)) orphanResult = true;
      seenToolCalls.add(callId);
      openToolCalls.add(callId);
    }
    if (fact.toolResultId && !openToolCalls.delete(fact.toolResultId)) orphanResult = true;
  }
  const hintedIncomplete = hints.some((hint) => !hint.complete && hint.entryIds.some((id) => facts.some((fact) => fact.entry.id === id)));
  const messages = facts.flatMap((fact) => fact.messages);
  const unit: SemanticUnit = {
    id: `unit-${unitIndex + 1}`,
    entryIds: facts.map((fact) => fact.entry.id),
    messages,
    frames: createFrames(facts, unitIndex),
    estimatedTokens: estimateMessageList(messages),
    complete: hasUser && hasAssistant && openToolCalls.size === 0 && !orphanResult && !hintedIncomplete,
    toolCallCount: seenToolCalls.size,
    fileOperations: [...new Set(facts.flatMap((fact) => fact.fileOperations))].sort(),
  };
  return { unit, facts };
}

/**
 * Group entries from each user request through all assistant/tool/result work.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function buildSemanticUnits(facts: EntryFacts[], hints: CodexSemanticHint[]): UnitBuild[] {
  if (facts.length === 0) return [];
  const groups: EntryFacts[][] = [];
  let current: EntryFacts[] = [];
  for (const fact of facts) {
    if (startsNewUnit(current, fact, hints)) {
      groups.push(current);
      current = [];
    }
    current.push(fact);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => createUnit(group, index, hints));
}

/**
 * Validate a non-negative finite token option and round it to an integer.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function tokenOption(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0) {
    throw new CodexImportError("COMPACTION_PLAN_INVALID", `${name} must be a non-negative finite number`);
  }
  return Math.floor(selected);
}

/**
 * Derive dynamic output, prompt, previous-summary, safety, and recent budgets.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createPlanningBudget(options: PlanSemanticCompactionOptions): PlanningBudget {
  const contextWindow = options.currentModel.contextWindow;
  const maxTokens = options.currentModel.maxTokens > 0 ? options.currentModel.maxTokens : contextWindow;
  const defaultReserve = Math.min(maxTokens, Math.max(512, Math.floor(contextWindow * 0.1)));
  const reserveTokens = tokenOption(options.reserveTokens ?? options.summaryReserveTokens, defaultReserve, "reserveTokens");
  const safetyTokens = tokenOption(options.safetyTokens, Math.max(256, Math.floor(contextWindow * 0.025)), "safetyTokens");
  const templateTokens = tokenOption(
    options.templateTokens,
    DEFAULT_SUMMARY_PROMPT_OVERHEAD_TOKENS + estimateText(SUMMARY_TEMPLATE),
    "templateTokens",
  );
  const previousSummaryTokens = options.previousSummary ? estimateText(options.previousSummary) : 0;
  const keepRecentTokens = tokenOption(options.keepRecentTokens, DEFAULT_KEEP_RECENT_TOKENS, "keepRecentTokens");
  return {
    reserveTokens,
    safetyTokens,
    templateTokens,
    previousSummaryTokens,
    keepRecentTokens,
    finalKeptCapacity: Math.max(0, contextWindow - reserveTokens - safetyTokens),
  };
}

/**
 * Calculate one model's safe summarization input capacity without a fixed ceiling.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function safeInputCapacity(model: CompressionModelDescriptor, budget: PlanningBudget): number {
  const modelSafetyTokens = Math.max(budget.safetyTokens, Math.floor(model.contextWindow * 0.025));
  return Math.floor(
    model.contextWindow
    - budget.reserveTokens
    - budget.templateTokens
    - budget.previousSummaryTokens
    - modelSafetyTokens,
  );
}

/**
 * Select a suffix of complete tasks near the soft recent-token target.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function selectRecentUnits(units: SemanticUnit[], budget: PlanningBudget): { kept: SemanticUnit[]; summarized: SemanticUnit[] } {
  const target = Math.min(budget.keepRecentTokens, budget.finalKeptCapacity);
  const earliestIncomplete = units.findIndex((unit) => !unit.complete);
  let firstKeptIndex = earliestIncomplete >= 0 ? earliestIncomplete : units.length;
  let keptTokens = units
    .slice(firstKeptIndex)
    .reduce((total, unit) => total + unit.estimatedTokens, 0);
  if (keptTokens > budget.finalKeptCapacity) {
    return { kept: units.slice(firstKeptIndex), summarized: units.slice(0, firstKeptIndex) };
  }
  for (let index = firstKeptIndex - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const wantsAtLeastOne = firstKeptIndex === units.length;
    if (!wantsAtLeastOne && keptTokens >= target) break;
    if (keptTokens + unit.estimatedTokens > budget.finalKeptCapacity) break;
    keptTokens += unit.estimatedTokens;
    firstKeptIndex = index;
  }
  return { kept: units.slice(firstKeptIndex), summarized: units.slice(0, firstKeptIndex) };
}

/**
 * Move whole task units into the recent suffix when that enables one safe call.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function optimizeSingleCallPartition(
  summarized: SemanticUnit[],
  kept: SemanticUnit[],
  capacity: number,
  budget: PlanningBudget,
): { kept: SemanticUnit[]; summarized: SemanticUnit[] } {
  const nextSummarized = [...summarized];
  const nextKept = [...kept];
  let summaryTokens = nextSummarized.reduce((total, unit) => total + unit.estimatedTokens, 0);
  let keptTokens = nextKept.reduce((total, unit) => total + unit.estimatedTokens, 0);
  while (summaryTokens > capacity && nextSummarized.length > 1) {
    const candidate = nextSummarized.at(-1)!;
    if (!candidate.complete || keptTokens + candidate.estimatedTokens > budget.finalKeptCapacity) break;
    nextSummarized.pop();
    nextKept.unshift(candidate);
    summaryTokens -= candidate.estimatedTokens;
    keptTokens += candidate.estimatedTokens;
  }
  return { kept: nextKept, summarized: nextSummarized };
}

/**
 * Build continuity metadata for an intentionally split oversized task.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function continuityForUnit(unit: SemanticUnit, frame: SemanticFrame, index: number): NonNullable<SemanticSummaryChunk["continuity"]> {
  const userText = unit.messages.find((message) => message.role === "user");
  const frameText = frame.messages.map(messageText).filter(Boolean).join("\n");
  const heading = frameText.match(/(^|\n)#{1,6}\s+([^\n]+)/)?.[2]?.trim();
  const previousFrame = index > 0 ? unit.frames[index - 1] : undefined;
  const previousConclusion = previousFrame
    ? previousFrame.messages.map(messageText).filter(Boolean).join("\n").slice(-2_000)
    : "";
  return {
    originalRequest: messageText(userText ?? textEstimationMessage("Unknown imported request")).slice(0, 2_000),
    currentGoal: heading ?? `Continue oversized task phase ${index + 1}`,
    dependencies: previousConclusion ? [`Previous phase conclusion:\n${previousConclusion}`] : [],
  };
}

/**
 * Convert summary units into indivisible unit parts or reliable oversized frames.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function summaryParts(units: SemanticUnit[], capacity: number): SemanticSummaryChunk[] | undefined {
  const parts: SemanticSummaryChunk[] = [];
  for (const unit of units) {
    if (!unit.complete) return undefined;
    if (unit.estimatedTokens <= capacity) {
      parts.push({
        id: `part-${parts.length + 1}`,
        level: 0,
        entryIds: [...unit.entryIds],
        unitIds: [unit.id],
        estimatedTokens: unit.estimatedTokens,
        inputRefs: [...unit.entryIds],
      });
      continue;
    }
    if (unit.frames.length < 2 || unit.frames.some((frame) => !frame.safeBoundary || frame.estimatedTokens > capacity)) {
      return undefined;
    }
    for (let index = 0; index < unit.frames.length; index += 1) {
      const frame = unit.frames[index];
      const continuity = continuityForUnit(unit, frame, index);
      const estimatedTokens = frame.estimatedTokens + estimateText(stableStringify(continuity));
      if (estimatedTokens > capacity) return undefined;
      parts.push({
        id: `part-${parts.length + 1}`,
        level: 0,
        entryIds: [...frame.entryIds],
        unitIds: [unit.id],
        estimatedTokens,
        inputRefs: [...frame.entryIds],
        continuity,
      });
    }
  }
  return parts;
}

/**
 * Greedily pack ordered semantic parts into capacity-safe leaf chunks.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function packLeafChunks(parts: SemanticSummaryChunk[], capacity: number): SemanticSummaryChunk[] {
  const chunks: SemanticSummaryChunk[] = [];
  let pending: SemanticSummaryChunk[] = [];
  let pendingTokens = 0;
  const flush = (): void => {
    if (pending.length === 0) return;
    const entryIds = pending.flatMap((part) => part.entryIds);
    chunks.push({
      id: `leaf-${String(chunks.length + 1).padStart(4, "0")}-${hashObject(entryIds).slice(0, 8)}`,
      level: 0,
      entryIds,
      unitIds: [...new Set(pending.flatMap((part) => part.unitIds))],
      estimatedTokens: pendingTokens,
      inputRefs: pending.flatMap((part) => part.inputRefs),
      continuity: pending.find((part) => part.continuity)?.continuity,
    });
    pending = [];
    pendingTokens = 0;
  };
  for (const part of parts) {
    if (pending.length > 0 && pendingTokens + part.estimatedTokens > capacity) flush();
    pending.push(part);
    pendingTokens += part.estimatedTokens;
  }
  flush();
  return chunks;
}

/**
 * Estimate bounded summary output size for hierarchy planning.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function projectedSummaryTokens(_inputTokens: number, capacity: number, reserveTokens: number): number {
  const nativeOutputLimit = Math.max(
    32,
    Math.floor(reserveTokens * MODEL_SUMMARY_RESERVE_RATIO * 0.8),
  );
  return Math.max(32, Math.min(capacity, nativeOutputLimit));
}

/**
 * Group child summary nodes so every merge has at least two ordered inputs.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function packMergeNodes(nodes: MergeNode[], capacity: number): MergeNode[][] | undefined {
  const groups: MergeNode[][] = [];
  let index = 0;
  while (index < nodes.length) {
    const group: MergeNode[] = [];
    let tokens = 0;
    while (index < nodes.length && tokens + nodes[index].estimatedOutputTokens <= capacity) {
      group.push(nodes[index]);
      tokens += nodes[index].estimatedOutputTokens;
      index += 1;
    }
    if (group.length === 0) return undefined;
    groups.push(group);
  }
  if (groups.length > 1 && groups.at(-1)!.length === 1) {
    const previous = groups.at(-2)!;
    if (previous.length < 3) return undefined;
    groups.at(-1)!.unshift(previous.pop()!);
  }
  if (groups.some((group) => group.length < 2)) return undefined;
  return groups.some((group) => group.reduce((sum, node) => sum + node.estimatedOutputTokens, 0) > capacity)
    ? undefined
    : groups;
}

/**
 * Create leaf and ordered hierarchical merge calls for packed chunks.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createHierarchicalCalls(
  chunks: SemanticSummaryChunk[],
  capacity: number,
  reserveTokens: number,
): SemanticSummaryCall[] | undefined {
  const calls: SemanticSummaryCall[] = chunks.map((chunk) => ({
    ...chunk,
    id: `call-${chunk.id}`,
    phase: "leaf",
    dependsOn: [],
  }));
  let nodes: MergeNode[] = calls.map((call) => ({
    id: call.id,
    entryIds: call.entryIds,
    unitIds: call.unitIds,
    estimatedOutputTokens: projectedSummaryTokens(call.estimatedTokens, capacity, reserveTokens)
      + MERGE_CHILD_WRAPPER_TOKENS,
  }));
  let level = 1;
  while (nodes.length > 1) {
    const groups = packMergeNodes(nodes, capacity);
    if (!groups) return undefined;
    const finalLayer = groups.length === 1;
    const nextNodes: MergeNode[] = [];
    for (const group of groups) {
      const entryIds = group.flatMap((node) => node.entryIds);
      const inputTokens = group.reduce((sum, node) => sum + node.estimatedOutputTokens, 0);
      const call: SemanticSummaryCall = {
        id: `call-${finalLayer ? "final" : "merge"}-${level}-${String(nextNodes.length + 1).padStart(3, "0")}-${hashObject(entryIds).slice(0, 8)}`,
        level,
        entryIds,
        unitIds: [...new Set(group.flatMap((node) => node.unitIds))],
        estimatedTokens: inputTokens,
        inputRefs: group.map((node) => node.id),
        phase: finalLayer ? "final" : "merge",
        dependsOn: group.map((node) => node.id),
      };
      calls.push(call);
      nextNodes.push({
        id: call.id,
        entryIds,
        unitIds: call.unitIds,
        estimatedOutputTokens: projectedSummaryTokens(inputTokens, capacity, reserveTokens)
          + MERGE_CHILD_WRAPPER_TOKENS,
      });
    }
    if (nextNodes.length >= nodes.length) return undefined;
    nodes = nextNodes;
    level += 1;
  }
  return calls;
}

/**
 * Construct one candidate model plan, rejecting unsafe indivisible tasks.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function tryCandidatePlan(
  model: CompressionModelDescriptor,
  units: SemanticUnit[],
  budget: PlanningBudget,
): CandidatePlanParts | undefined {
  const capacity = safeInputCapacity(model, budget);
  if (capacity < MIN_SAFE_INPUT_TOKENS) return undefined;
  const recent = selectRecentUnits(units, budget);
  const partition = optimizeSingleCallPartition(recent.summarized, recent.kept, capacity, budget);
  const keptTokens = partition.kept.reduce((total, unit) => total + unit.estimatedTokens, 0);
  if (partition.summarized.length === 0 || keptTokens > budget.finalKeptCapacity) return undefined;
  const parts = summaryParts(partition.summarized, capacity);
  if (!parts) return undefined;
  const summaryTokens = partition.summarized.reduce((total, unit) => total + unit.estimatedTokens, 0);
  if (summaryTokens <= capacity) {
    const entryIds = partition.summarized.flatMap((unit) => unit.entryIds);
    const chunk: SemanticSummaryChunk = {
      id: `single-${hashObject(entryIds).slice(0, 8)}`,
      level: 0,
      entryIds,
      unitIds: partition.summarized.map((unit) => unit.id),
      estimatedTokens: summaryTokens,
      inputRefs: [...entryIds],
      continuity: parts.find((part) => part.continuity)?.continuity,
    };
    return {
      model,
      safeInputCapacity: capacity,
      keptUnits: partition.kept,
      summaryUnits: partition.summarized,
      leafChunks: [chunk],
      calls: [{ ...chunk, id: `call-${chunk.id}`, phase: "single", dependsOn: [] }],
      mode: "single",
    };
  }
  const chunks = packLeafChunks(parts, capacity);
  if (chunks.length < 2) return undefined;
  const calls = createHierarchicalCalls(chunks, capacity, budget.reserveTokens);
  if (!calls) return undefined;
  return {
    model,
    safeInputCapacity: capacity,
    keptUnits: partition.kept,
    summaryUnits: partition.summarized,
    leafChunks: chunks,
    calls,
    mode: "hierarchical",
  };
}

/**
 * Return available descriptors once, preferring larger windows within a tier.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function availableUniqueModels(models: CompressionModelDescriptor[]): CompressionModelDescriptor[] {
  const seen = new Set<string>();
  return models
    .filter((model) => model.available !== false && model.contextWindow > 0)
    .sort((left, right) => right.contextWindow - left.contextWindow)
    .filter((model) => {
      const key = `${model.provider}\u0000${model.id}\u0000${model.endpointFingerprint ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Return the signed endpoint boundary used for transfer confirmation decisions.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function endpointBoundary(model: CompressionModelDescriptor): string {
  return model.endpointFingerprint ?? `provider:${model.provider}`;
}

/**
 * Choose current, same-provider authorized, or explicitly confirmed cross-provider capacity.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function chooseCandidatePlan(
  options: PlanSemanticCompactionOptions,
  units: SemanticUnit[],
  budget: PlanningBudget,
): CandidatePlanParts {
  const available = availableUniqueModels(options.availableModels);
  const currentAvailable = options.currentModel.available !== false;
  if (currentAvailable) {
    const currentPlan = tryCandidatePlan(options.currentModel, units, budget);
    if (currentPlan) return currentPlan;
  }
  const currentEndpoint = endpointBoundary(options.currentModel);
  const sameProvider = available.filter((model) => (
    endpointBoundary(model) === currentEndpoint
    && (model.provider !== options.currentModel.provider || model.id !== options.currentModel.id)
  ));
  for (const model of sameProvider) {
    const candidate = tryCandidatePlan(model, units, budget);
    if (candidate) return candidate;
  }

  const viableCrossModels = available.filter((model) => (
    endpointBoundary(model) !== currentEndpoint && tryCandidatePlan(model, units, budget)
  ));
  if (viableCrossModels.length > 0 && (!options.crossProviderConfirmed || !options.crossProviderModel)) {
    throw new CodexImportError(
      "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
      "A cross-provider long-context model is required and must be explicitly selected and confirmed",
      { availableModels: viableCrossModels.map((model) => ({ provider: model.provider, modelId: model.id })) },
    );
  }
  if (options.crossProviderConfirmed && options.crossProviderModel) {
    const selected = available.find((model) => (
      model.provider === options.crossProviderModel!.provider && model.id === options.crossProviderModel!.modelId
    ));
    if (selected && endpointBoundary(selected) !== currentEndpoint) {
      const candidate = tryCandidatePlan(selected, units, budget);
      if (candidate) return candidate;
    }
  }
  throw new CodexImportError(
    "LONG_CONTEXT_MODEL_UNAVAILABLE",
    "No authorized available model can safely compact the imported semantic units",
    {
      currentModel: `${options.currentModel.provider}/${options.currentModel.id}`,
      requiredSafeBoundary: true,
    },
  );
}

/**
 * Derive a collision-free deterministic ID for the future compaction entry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function compactionEntryId(sourceHash: string, sourceVersion: string, entries: SessionEntry[]): string {
  const existing = new Set(entries.map((entry) => entry.id));
  let attempt = 0;
  while (attempt < 100) {
    const id = hashText(`${sourceVersion}\u0000${sourceHash}\u0000${attempt}`).slice(0, 8);
    if (!existing.has(id)) return id;
    attempt += 1;
  }
  return randomUUID().slice(0, 8);
}

/**
 * Return the stable subset of a plan that participates in planHash.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function planHashPayload(plan: RuntimeSemanticCompactionPlan): unknown {
  return {
    algorithmVersion: COMPACTION_ALGORITHM_VERSION,
    mode: plan.mode,
    sourceVersion: plan.sourceVersion,
    sourceHash: plan.sourceHash,
    previousSummaryHash: plan.previousSummaryHash,
    originalTokens: plan.originalTokens,
    keptTokens: plan.keptTokens,
    safeInputCapacity: plan.safeInputCapacity,
    estimatedChunks: plan.estimatedChunks,
    estimatedLayers: plan.estimatedLayers,
    estimatedCalls: plan.estimatedCalls,
    lossless: plan.lossless,
    lossy: plan.lossy,
    crossProvider: plan.crossProvider,
    compressionModel: {
      provider: plan.compressionModel.provider,
      id: plan.compressionModel.id,
      contextWindow: plan.compressionModel.contextWindow,
      maxTokens: plan.compressionModel.maxTokens,
      endpointFingerprint: plan.compressionModel.endpointFingerprint,
      available: plan.compressionModel.available,
    },
    targetProvider: plan.targetProvider,
    targetModelId: plan.targetModelId,
    firstKeptEntryId: plan.firstKeptEntryId,
    keptEntryIds: plan.keptEntryIds,
    summaryEntryIds: plan.summaryEntryIds,
    units: plan.units.map((unit) => ({
      id: unit.id,
      entryIds: unit.entryIds,
      estimatedTokens: unit.estimatedTokens,
      complete: unit.complete,
      toolCallCount: unit.toolCallCount,
      fileOperations: unit.fileOperations,
      frames: unit.frames.map((frame) => ({
        id: frame.id,
        entryIds: frame.entryIds,
        estimatedTokens: frame.estimatedTokens,
        safeBoundary: frame.safeBoundary,
      })),
    })),
    leafChunks: plan.leafChunks,
    calls: plan.calls,
    reserveTokens: plan.reserveTokens,
    safetyTokens: plan.safetyTokens,
    templateTokens: plan.templateTokens,
    compactionEntryId: plan.compactionEntryId,
  };
}

/**
 * Finalize planHash after every visible planning field has been populated.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function finalizePlan(plan: RuntimeSemanticCompactionPlan): RuntimeSemanticCompactionPlan {
  plan.planHash = hashObject(planHashPayload(plan));
  return plan;
}

/**
 * Plan context-safe no-op, single-call, or ordered hierarchical semantic compaction.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function planSemanticCompaction(options: PlanSemanticCompactionOptions): SemanticCompactionPlan {
  if (!options.sourceVersion) {
    throw new CodexImportError("COMPACTION_PLAN_INVALID", "sourceVersion is required for semantic compaction");
  }
  if (options.currentModel.contextWindow <= 0) {
    throw new CodexImportError("LONG_CONTEXT_MODEL_UNAVAILABLE", "The current model has no usable context window");
  }
  const facts = analyzeEntries(options.entries);
  const unitBuilds = buildSemanticUnits(facts, options.semanticHints ?? []);
  const units = unitBuilds.map((build) => build.unit);
  const originalTokens = facts.reduce((total, fact) => total + fact.tokens, 0);
  const sourceHash = hashObject(options.entries);
  const budget = createPlanningBudget(options);
  const currentSafeInput = safeInputCapacity(options.currentModel, budget);
  const contextSafeCapacity = budget.finalKeptCapacity;
  const nextCompactionId = compactionEntryId(sourceHash, options.sourceVersion, options.entries);

  if (originalTokens <= contextSafeCapacity) {
    return finalizePlan({
      mode: "none",
      planHash: "",
      sourceVersion: options.sourceVersion,
      sourceHash,
      previousSummary: options.previousSummary,
      previousSummaryHash: hashText(options.previousSummary ?? ""),
      compactionEntryId: nextCompactionId,
      targetProvider: options.currentModel.provider,
      targetModelId: options.currentModel.id,
      originalTokens,
      keptTokens: originalTokens,
      safeInputCapacity: currentSafeInput,
      estimatedChunks: 0,
      estimatedLayers: 0,
      estimatedCalls: 0,
      lossless: true,
      lossy: false,
      crossProvider: false,
      compressionModel: options.currentModel,
      firstKeptEntryId: null,
      keptEntryIds: options.entries.map((entry) => entry.id),
      summaryEntryIds: [],
      units,
      leafChunks: [],
      calls: [],
      reserveTokens: budget.reserveTokens,
      safetyTokens: budget.safetyTokens,
      templateTokens: budget.templateTokens,
    });
  }

  const candidate = chooseCandidatePlan(options, units, budget);
  const keptEntryIds = candidate.keptUnits.flatMap((unit) => unit.entryIds);
  const summaryEntryIds = candidate.summaryUnits.flatMap((unit) => unit.entryIds);
  const firstKeptEntryId = keptEntryIds[0] ?? nextCompactionId;
  const layers = candidate.calls.reduce((maximum, call) => Math.max(maximum, call.level + 1), 0);
  const plan = finalizePlan({
    mode: candidate.mode,
    planHash: "",
    sourceVersion: options.sourceVersion,
    sourceHash,
    previousSummary: options.previousSummary,
    previousSummaryHash: hashText(options.previousSummary ?? ""),
    compactionEntryId: nextCompactionId,
    targetProvider: options.currentModel.provider,
    targetModelId: options.currentModel.id,
    originalTokens,
    keptTokens: candidate.keptUnits.reduce((total, unit) => total + unit.estimatedTokens, 0),
    safeInputCapacity: candidate.safeInputCapacity,
    estimatedChunks: candidate.leafChunks.length,
    estimatedLayers: layers,
    estimatedCalls: candidate.calls.length,
    lossless: false,
    lossy: true,
    crossProvider: endpointBoundary(candidate.model) !== endpointBoundary(options.currentModel),
    compressionModel: candidate.model,
    firstKeptEntryId,
    keptEntryIds,
    summaryEntryIds,
    units,
    leafChunks: candidate.leafChunks,
    calls: candidate.calls,
    reserveTokens: budget.reserveTokens,
    safetyTokens: Math.max(budget.safetyTokens, Math.floor(candidate.model.contextWindow * 0.025)),
    templateTokens: budget.templateTokens,
  });
  validateCompactionCoverage(plan, options.entries);
  coverageManifestForPlan(plan);
  return plan;
}

/**
 * Assert two ID sequences are exactly equal.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertIdSequence(actual: string[], expected: string[], message: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new CodexImportError("COMPACTION_COVERAGE_INVALID", message, { actual, expected });
  }
}

/**
 * Validate that tool calls and results remain in the same leaf or kept partition.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateToolPairCoverage(plan: SemanticCompactionPlan, entries: SessionEntry[]): void {
  const location = new Map<string, string>();
  plan.keptEntryIds.forEach((id) => location.set(id, "kept"));
  plan.leafChunks.forEach((chunk) => chunk.entryIds.forEach((id) => location.set(id, chunk.id)));
  const calls = new Map<string, string>();
  const results = new Map<string, string>();
  for (const entry of entries) {
    for (const call of toolCallsFromEntry(entry)) calls.set(call.id, entry.id);
    const resultId = toolResultIdFromEntry(entry);
    if (resultId) results.set(resultId, entry.id);
  }
  for (const [callId, callEntryId] of calls) {
    const resultEntryId = results.get(callId);
    if (resultEntryId && location.get(callEntryId) !== location.get(resultEntryId)) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", `Tool call/result pair ${callId} crosses a semantic chunk`);
    }
  }
}

/**
 * Validate ordered hierarchy dependencies and exact child coverage.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateCallHierarchy(plan: SemanticCompactionPlan): void {
  const completed = new Map<string, SemanticSummaryCall>();
  for (const call of plan.calls) {
    if (completed.has(call.id)) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", `Duplicate summary call ID ${call.id}`);
    }
    if (call.dependsOn.length > 0) {
      const dependencies = call.dependsOn.map((id) => completed.get(id));
      if (dependencies.some((dependency) => !dependency)) {
        throw new CodexImportError("COMPACTION_COVERAGE_INVALID", `Summary call ${call.id} has a missing dependency`);
      }
      const childIds = dependencies.flatMap((dependency) => dependency!.entryIds);
      assertIdSequence(call.entryIds, childIds, `Summary call ${call.id} does not exactly cover its ordered children`);
      if (new Set(childIds).size !== childIds.length) {
        throw new CodexImportError("COMPACTION_COVERAGE_INVALID", `Summary call ${call.id} duplicates child coverage`);
      }
    }
    completed.set(call.id, call);
  }
  if (plan.calls.length > 0) {
    assertIdSequence(plan.calls.at(-1)!.entryIds, plan.summaryEntryIds, "Terminal summary call has incomplete coverage");
  }
}

/**
 * Validate exact source, unit, leaf, tool, and hierarchy coverage without gaps or duplicates.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function validateCompactionCoverage(plan: SemanticCompactionPlan, entries: SessionEntry[]): void {
  const runtimePlan = plan as RuntimeSemanticCompactionPlan;
  const sourceIds = entries.map((entry) => entry.id);
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Source entry IDs are not unique");
  }
  assertIdSequence([...plan.summaryEntryIds, ...plan.keptEntryIds], sourceIds, "Summary and kept entries do not partition the source in order");
  if (new Set([...plan.summaryEntryIds, ...plan.keptEntryIds]).size !== sourceIds.length) {
    throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Compaction coverage contains duplicate entry IDs");
  }
  assertIdSequence(plan.units.flatMap((unit) => unit.entryIds), sourceIds, "Semantic units do not exactly cover the source");
  assertIdSequence(plan.leafChunks.flatMap((chunk) => chunk.entryIds), plan.summaryEntryIds, "Leaf chunks do not exactly cover summarized entries");
  if (plan.mode === "none") {
    if (plan.calls.length !== 0 || plan.summaryEntryIds.length !== 0 || plan.firstKeptEntryId !== null || plan.lossy) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "No-op compaction plan contains lossy work");
    }
  } else {
    if (plan.firstKeptEntryId !== (plan.keptEntryIds[0] ?? runtimePlan.compactionEntryId)) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "firstKeptEntryId is not the first complete kept boundary");
    }
    if (plan.estimatedChunks !== plan.leafChunks.length || plan.estimatedCalls !== plan.calls.length) {
      throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Displayed compaction counts do not match the plan");
    }
  }
  if (plan.lossless === plan.lossy) {
    throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Plan lossless/lossy flags are inconsistent");
  }
  const expectedLayers = plan.calls.reduce((maximum, call) => Math.max(maximum, call.level + 1), 0);
  if (plan.estimatedLayers !== expectedLayers) {
    throw new CodexImportError("COMPACTION_COVERAGE_INVALID", "Displayed compaction layers do not match the plan");
  }
  validateToolPairCoverage(plan, entries);
  validateCallHierarchy(plan);
  if (runtimePlan.previousSummaryHash !== hashText(runtimePlan.previousSummary ?? "")) {
    throw new CodexImportError("COMPACTION_PLAN_CHANGED", "Previous summary changed after planning");
  }
  if (runtimePlan.sourceHash !== hashObject(entries)) {
    throw new CodexImportError("COMPACTION_SOURCE_CHANGED", "Compaction source entries changed after planning");
  }
  if (runtimePlan.planHash !== hashObject(planHashPayload(runtimePlan))) {
    throw new CodexImportError("COMPACTION_PLAN_CHANGED", "Compaction plan hash validation failed");
  }
}

/**
 * Load or create a private persistent key used to authenticate resumable checkpoints.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function checkpointIntegrityKey(checkpointRoot: string): Buffer {
  const keyPath = join(checkpointRoot, ".integrity-key");
  if (!existsSync(keyPath)) {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        keyPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        0o600,
      );
      const key = randomBytes(32);
      let offset = 0;
      while (offset < key.length) offset += writeSync(descriptor, key, offset, key.length - offset);
      fsyncSync(descriptor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  const opened = openRegularFileNoFollow(keyPath);
  try {
    const stats = fstatSync(opened.fd);
    if (stats.size !== 32) {
      throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint integrity key is invalid");
    }
    const key = Buffer.alloc(32);
    if (readSync(opened.fd, key, 0, key.length, 0) !== key.length) {
      throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint integrity key could not be read");
    }
    return key;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Authenticate exactly the checkpoint identity and record content used on resume.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function checkpointSignature(key: Buffer, payload: Record<string, unknown>): string {
  return createHmac("sha256", key).update(stableStringify(payload)).digest("base64url");
}

/**
 * Validate checkpoint envelopes and perform atomic per-call persistence.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
class FileCompactionCheckpointStore implements CompactionCheckpointStore {
  readonly directory: string;
  readonly sourceVersion: string;
  readonly planHash: string;
  private readonly integrityKey: Buffer;

  /**
   * Bind a checkpoint directory to one thread, source version, and plan hash.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  constructor(options: CreateFileCompactionCheckpointStoreOptions) {
    const identity = hashObject({
      threadId: options.threadId,
      sourceVersion: options.sourceVersion,
      planHash: options.planHash,
    });
    const agentRoot = resolve(options.agentDir);
    const checkpointRoot = ensureSecureDirectory(agentRoot, join(agentRoot, "imports", "codex", "checkpoints"));
    this.directory = join(checkpointRoot, identity);
    this.sourceVersion = options.sourceVersion;
    this.planHash = options.planHash;
    this.integrityKey = checkpointIntegrityKey(checkpointRoot);
  }

  /**
   * Derive a traversal-safe file path from an opaque summary call ID.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private pathFor(callId: string): string {
    return join(this.directory, `${hashText(callId)}.json`);
  }

  /**
   * Load and strictly validate one completed summary call checkpoint.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async load(callId: string): Promise<CompactionCheckpointRecord | undefined> {
    const checkpointPath = this.pathFor(callId);
    if (!existsSync(checkpointPath)) return undefined;
    assertNoLinkedPathComponents(this.directory);
    const opened = openRegularFileNoFollow(checkpointPath);
    let content: string;
    try {
      const before = fstatSync(opened.fd);
      if (before.size <= 0 || before.size > MAX_CHECKPOINT_BYTES) {
        throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Compaction checkpoint size is invalid");
      }
      const buffer = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = readSync(opened.fd, buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Compaction checkpoint was truncated");
        offset += bytesRead;
      }
      const after = fstatSync(opened.fd);
      const pathAfter = lstatSync(checkpointPath);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
        throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Compaction checkpoint changed while being read");
      }
      content = buffer.toString("utf8");
    } finally {
      closeSync(opened.fd);
    }
    try {
      const envelope = JSON.parse(content) as Record<string, unknown>;
      const payload = {
        version: envelope.version,
        callId: envelope.callId,
        sourceVersion: envelope.sourceVersion,
        planHash: envelope.planHash,
        record: envelope.record,
      };
      const supplied = typeof envelope.integrity === "string"
        ? Buffer.from(envelope.integrity, "base64url")
        : Buffer.alloc(0);
      const expected = Buffer.from(checkpointSignature(this.integrityKey, payload), "base64url");
      if (
        envelope.version !== CHECKPOINT_FORMAT_VERSION
        || envelope.callId !== callId
        || envelope.sourceVersion !== this.sourceVersion
        || envelope.planHash !== this.planHash
        || supplied.length !== expected.length
        || !timingSafeEqual(supplied, expected)
      ) {
        throw new Error("checkpoint identity or integrity mismatch");
      }
      const record = envelope.record as CompactionCheckpointRecord;
      if (!record || typeof record.text !== "string" || typeof record.inputHash !== "string" || !Array.isArray(record.entryIds)) {
        throw new Error("checkpoint record is malformed");
      }
      return record;
    } catch (error) {
      if (error instanceof CodexImportError) throw error;
      throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", `Invalid compaction checkpoint for ${callId}`);
    }
  }

  /**
   * Save one completed call through fsync plus same-directory atomic rename.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async save(callId: string, record: CompactionCheckpointRecord): Promise<void> {
    const target = this.pathFor(callId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const payload = {
      version: CHECKPOINT_FORMAT_VERSION,
      callId,
      sourceVersion: this.sourceVersion,
      planHash: this.planHash,
      record,
    };
    const envelope = `${JSON.stringify({
      ...payload,
      integrity: checkpointSignature(this.integrityKey, payload),
    })}\n`;
    if (Buffer.byteLength(envelope, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Compaction checkpoint exceeds the safe size limit");
    }
    const checkpointRoot = resolve(this.directory, "..");
    ensureSecureDirectory(checkpointRoot, this.directory);
    assertNoLinkedPathComponents(this.directory);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(envelope, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove only this source-and-plan-bound checkpoint directory.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async remove(): Promise<void> {
    const checkpointRoot = resolve(this.directory, "..");
    assertNoLinkedPathComponents(checkpointRoot);
    assertNoLinkedPathComponents(this.directory);
    if (!isPathWithin(this.directory, checkpointRoot)) {
      throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint cleanup escaped its fixed root");
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

/**
 * Create an atomic file checkpoint store bound to thread/source/plan identity.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createFileCompactionCheckpointStore(
  options: CreateFileCompactionCheckpointStoreOptions,
): CompactionCheckpointStore {
  if (!options.agentDir || !options.threadId || !options.sourceVersion || !options.planHash) {
    throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint agentDir, threadId, sourceVersion, and planHash are required");
  }
  return new FileCompactionCheckpointStore(options);
}

/**
 * Sum Pi usage records from all fresh and resumed summary calls.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function addUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    cacheRead: current.cacheRead + next.cacheRead,
    cacheWrite: current.cacheWrite + next.cacheWrite,
    ...(current.cacheWrite1h !== undefined || next.cacheWrite1h !== undefined
      ? { cacheWrite1h: (current.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }
      : {}),
    ...(current.reasoning !== undefined || next.reasoning !== undefined
      ? { reasoning: (current.reasoning ?? 0) + (next.reasoning ?? 0) }
      : {}),
    totalTokens: current.totalTokens + next.totalTokens,
    cost: {
      input: current.cost.input + next.cost.input,
      output: current.cost.output + next.cost.output,
      cacheRead: current.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: current.cost.cacheWrite + next.cost.cacheWrite,
      total: current.cost.total + next.cost.total,
    },
  };
}

/**
 * Derive exact tool and file coverage metadata for an entry-ID sequence.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function coverageMetadata(entryIds: string[], factsById: Map<string, EntryFacts>): { toolCallCount: number; fileOperations: string[] } {
  let toolCallCount = 0;
  const fileOperations = new Set<string>();
  for (const id of entryIds) {
    const fact = factsById.get(id);
    if (!fact) throw new CodexImportError("COMPACTION_SOURCE_CHANGED", `Entry ${id} is missing during execution`);
    toolCallCount += fact.toolCallIds.length;
    fact.fileOperations.forEach((operation) => fileOperations.add(operation));
  }
  return { toolCallCount, fileOperations: [...fileOperations].sort() };
}

/**
 * Build the exact hash-bound input supplied to an injected summarizer.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function buildSummaryInput(
  call: SemanticSummaryCall,
  plan: RuntimeSemanticCompactionPlan,
  factsById: Map<string, EntryFacts>,
  completed: Map<string, CompletedCall>,
): SemanticSummaryInput {
  const children = call.dependsOn.map((callId) => {
    const child = completed.get(callId);
    if (!child) throw new CodexImportError("COMPACTION_PLAN_INVALID", `Dependency ${callId} has not completed`);
    return { callId, text: child.record.text, entryIds: child.record.entryIds, hash: child.hash };
  });
  const messages = call.dependsOn.length === 0
    ? call.entryIds.flatMap((id) => factsById.get(id)?.messages ?? [])
    : [];
  const metadata = coverageMetadata(call.entryIds, factsById);
  const previousSummary = call.dependsOn.length === 0 && plan.calls[0]?.id === call.id
    ? plan.previousSummary
    : undefined;
  const inputHash = hashObject({
    planHash: plan.planHash,
    call,
    sourceEntries: call.dependsOn.length === 0 ? call.entryIds.map((id) => factsById.get(id)?.entry) : undefined,
    children,
    previousSummary,
    metadata,
  });
  return {
    messages,
    childSummaries: children,
    previousSummary,
    continuity: call.continuity,
    coverage: { entryIds: [...call.entryIds], inputHash, ...metadata },
    model: plan.compressionModel,
    reserveTokens: Math.max(64, Math.floor(plan.reserveTokens * MODEL_SUMMARY_RESERVE_RATIO)),
    instructions: SUMMARY_TEMPLATE,
  };
}

/**
 * Validate a loaded checkpoint against the exact current call input.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateCheckpoint(call: SemanticSummaryCall, input: SemanticSummaryInput, record: CompactionCheckpointRecord): void {
  if (record.inputHash !== input.coverage.inputHash) {
    throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", `Checkpoint input hash changed for ${call.id}`);
  }
  assertIdSequence(record.entryIds, call.entryIds, `Checkpoint coverage changed for ${call.id}`);
  if (!record.text.trim()) {
    throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", `Checkpoint summary is empty for ${call.id}`);
  }
}

/**
 * Estimate the dynamic source payload added around Pi's fixed summary prompts.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function estimateSummaryPayloadTokens(input: SemanticSummaryInput): number {
  const messageTokens = estimateMessageList(input.messages);
  const childTokens = input.childSummaries.reduce((total, child, index) => total + estimateText(
    `Checkpoint ${index + 1} (${child.entryIds.length} source entries, SHA-256 ${child.hash}):\n\n${child.text}`,
  ), 0);
  const continuityTokens = input.continuity ? estimateText(stableStringify(input.continuity)) : 0;
  return messageTokens + childTokens + continuityTokens;
}

/**
 * Build a bounded deterministic manifest that keeps source requests and file operations in active context.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function coverageManifestForPlan(plan: RuntimeSemanticCompactionPlan): string {
  const summarized = new Set(plan.summaryEntryIds);
  const coveredUnits = plan.units.filter((unit) => unit.entryIds.some((id) => summarized.has(id)));
  const userTexts = coveredUnits.flatMap((unit) => unit.messages
    .filter((message) => message.role === "user")
    .map((message) => messageText(message).trim())
    .filter(Boolean));
  const requestAnchors = [...new Set(userTexts
    .map((text) => text.split(/\r?\n/, 1)[0].slice(0, 240))
    .filter(Boolean))];
  const constraintPattern = /\b(must|must not|never|do not|don't|only|without|retain|preserve|compatible|forbid|required|off-limits|shall|should not|cannot|keep|need to|no\s+\w+\s+changes?)\b|必须|不得|禁止|不要|不能|仅限|保留|兼容|不可|请勿|务必|严禁|切勿|不允许|不应|应保持|只可/i;
  const constraintAnchors = [...new Set(userTexts.flatMap((text) => text
    .split(/\r?\n|(?<=[.!?。！？;；])/)
    .map((part) => part.trim())
    .filter((part) => part && constraintPattern.test(part))))];
  const criticalContextPattern = /\b(error|failed|failure|exception|denied|eacces|blocked|pending|unfinished|incomplete|retry|decided|decision|choose|chosen|switch|because|todo|exit(?:ed)?\s+with\s+code\s+[1-9])\b|错误|失败|异常|拒绝|阻塞|待处理|未完成|尚未|重试|决定|改用|选择|采用|由于|退出码/i;
  const coveredMessages = coveredUnits.flatMap((unit) => unit.messages);
  const criticalContextAnchors = [...new Set(coveredMessages.flatMap((message) => {
    if (message.role !== "assistant" && message.role !== "toolResult") return [];
    const text = messageText(message).trim();
    if (!text) return [];
    const messageRecord = message as unknown as Record<string, unknown>;
    if (message.role === "toolResult" && messageRecord.isError === true) {
      return [`Failed tool outcome: ${text}`];
    }
    const role = message.role === "toolResult" ? "Tool outcome" : "Decision or unfinished work";
    return text
      .split(/\r?\n|(?<=[.!?。！？;；])/)
      .map((part) => part.trim())
      .filter((part) => part && criticalContextPattern.test(part))
      .map((part) => `${role}: ${part}`);
  }))];
  const toolResultTexts = coveredMessages
    .filter((message) => message.role === "toolResult")
    .map(messageText);
  const fileOperations = [...new Set(coveredUnits.flatMap((unit) => unit.fileOperations))].sort();
  const toolCallCount = coveredUnits.reduce((total, unit) => total + unit.toolCallCount, 0);
  const lines = [
    "## Verified import coverage",
    `- Source entries: ${plan.summaryEntryIds.length}`,
    `- Coverage SHA-256: ${hashObject(plan.summaryEntryIds)}`,
    `- Tool calls: ${toolCallCount}; tool results: ${toolResultTexts.length}; tool-result SHA-256: ${hashObject(toolResultTexts)}`,
    `- Requests: ${requestAnchors.length}; critical constraints: ${constraintAnchors.length}; critical outcomes: ${criticalContextAnchors.length}; file operations: ${fileOperations.length}`,
    ...fileOperations.map((operation) => `- File operation: ${operation}`),
    ...constraintAnchors.map((constraint) => `- Critical constraint: ${constraint}`),
    ...criticalContextAnchors.map((anchor) => `- ${anchor}`),
  ];
  const tokenBudget = Math.max(128, Math.floor(plan.reserveTokens * COVERAGE_MANIFEST_RESERVE_RATIO));
  if (estimateText(lines.join("\n")) > tokenBudget) {
    throw new CodexImportError(
      "COMPACTION_CRITICAL_CONTEXT_TOO_LARGE",
      "Critical constraints and file operations cannot fit the active context safely",
    );
  }
  for (const anchor of requestAnchors) {
    const next = [...lines, `- Original request: ${anchor}`];
    if (estimateText(next.join("\n")) > tokenBudget) break;
    lines.push(`- Original request: ${anchor}`);
  }
  return lines.join("\n");
}

/**
 * Require Pi's native structured checkpoint sections before claiming semantic coverage.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateSummaryStructure(text: string): void {
  const headings = [
    "## Goal",
    "## Constraints & Preferences",
    "## Progress",
    "## Key Decisions",
    "## Next Steps",
    "## Critical Context",
  ];
  let previous = -1;
  for (let index = 0; index < headings.length; index += 1) {
    const position = text.indexOf(headings[index]);
    if (position <= previous) {
      throw new CodexImportError("SEMANTIC_SUMMARY_INCOMPLETE", "Compaction summary omitted a required semantic section");
    }
    const contentStart = position + headings[index].length;
    const contentEnd = index + 1 < headings.length ? text.indexOf(headings[index + 1], contentStart) : text.length;
    if (contentEnd < 0 || text.slice(contentStart, contentEnd).trim().length < 2) {
      throw new CodexImportError("SEMANTIC_SUMMARY_INCOMPLETE", "Compaction summary contains an empty semantic section");
    }
    previous = position;
  }
}

/**
 * Reject an unexpectedly large model summary before it can invalidate a parent merge budget.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateSummaryOutputSize(
  call: SemanticSummaryCall,
  plan: RuntimeSemanticCompactionPlan,
  text: string,
): void {
  const outputLimit = projectedSummaryTokens(call.estimatedTokens, plan.safeInputCapacity, plan.reserveTokens);
  if (estimateText(text) > outputLimit) {
    throw new CodexImportError(
      "SEMANTIC_SUMMARY_TOO_LARGE",
      "A compaction checkpoint exceeded its safe planned output budget",
    );
  }
  validateSummaryStructure(text);
  if (call.id === plan.calls.at(-1)?.id) {
    const verifiedSummary = `${text.trim()}\n\n${coverageManifestForPlan(plan)}`;
    if (estimateText(verifiedSummary) > plan.reserveTokens) {
      throw new CodexImportError("SEMANTIC_SUMMARY_TOO_LARGE", "Verified compaction summary exceeds the retained context budget");
    }
  }
}

/**
 * Validate an identity-aware checkpoint store against the current source and plan.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateCheckpointStoreBinding(
  store: CompactionCheckpointStore,
  plan: RuntimeSemanticCompactionPlan,
): void {
  const bound = store as CompactionCheckpointStore & { sourceVersion?: string; planHash?: string };
  if (bound.sourceVersion !== undefined && bound.sourceVersion !== plan.sourceVersion) {
    throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint store source version does not match the plan");
  }
  if (bound.planHash !== undefined && bound.planHash !== plan.planHash) {
    throw new CodexImportError("COMPACTION_CHECKPOINT_INVALID", "Checkpoint store plan hash does not match the plan");
  }
}

/**
 * Execute all planned calls in order, atomically checkpointing each successful call.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function executeSemanticCompactionPlan(
  options: ExecuteSemanticCompactionOptions,
): Promise<SemanticSummaryResult> {
  validateCompactionCoverage(options.plan, options.entries);
  const plan = options.plan as RuntimeSemanticCompactionPlan;
  validateCheckpointStoreBinding(options.checkpointStore, plan);
  if (plan.mode === "none") {
    return { summary: "", coveredEntryIds: [], callCount: 0, checkpointHits: 0, nodes: [] };
  }
  const facts = analyzeEntries(options.entries);
  const factsById = new Map(facts.map((fact) => [fact.entry.id, fact]));
  const completed = new Map<string, CompletedCall>();
  const nodes: SemanticSummaryResult["nodes"] = [];
  let checkpointHits = 0;
  let aggregateUsage: Usage | undefined;

  for (const call of plan.calls) {
    const input = buildSummaryInput(call, plan, factsById, completed);
    if (estimateSummaryPayloadTokens(input) > plan.safeInputCapacity) {
      throw new CodexImportError(
        "COMPACTION_RUNTIME_CAPACITY_EXCEEDED",
        "Actual compaction input exceeded the signed safe capacity",
      );
    }
    let record = await options.checkpointStore.load(call.id);
    if (record) {
      validateCheckpoint(call, input, record);
      validateSummaryOutputSize(call, plan, record.text);
      checkpointHits += 1;
    } else {
      const response = await options.summarize(call, input);
      if (!response || typeof response.text !== "string" || !response.text.trim()) {
        throw new CodexImportError("SEMANTIC_SUMMARY_FAILED", `Summarizer returned an empty result for ${call.id}`);
      }
      validateSummaryOutputSize(call, plan, response.text);
      record = {
        text: response.text,
        usage: response.usage,
        entryIds: [...call.entryIds],
        inputHash: input.coverage.inputHash,
      };
      await options.checkpointStore.save(call.id, record);
    }
    aggregateUsage = addUsage(aggregateUsage, record.usage);
    const summaryHash = hashObject({ text: record.text, entryIds: record.entryIds });
    completed.set(call.id, { call, record, hash: summaryHash });
    nodes.push({
      id: call.id,
      level: call.level,
      entryIds: [...call.entryIds],
      hash: summaryHash,
      toolCallCount: input.coverage.toolCallCount,
      fileOperations: input.coverage.fileOperations,
    });
  }

  const terminal = completed.get(plan.calls.at(-1)!.id);
  if (!terminal) throw new CodexImportError("SEMANTIC_SUMMARY_FAILED", "Compaction plan produced no terminal summary");
  return {
    summary: terminal.record.text,
    usage: aggregateUsage,
    coveredEntryIds: [...terminal.record.entryIds],
    callCount: plan.calls.length,
    checkpointHits,
    nodes,
  };
}

/**
 * Resolve a deterministic compaction ID while protecting against a changed source.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function resolveCompactionId(plan: RuntimeSemanticCompactionPlan, entries: SessionEntry[]): string {
  if (!entries.some((entry) => entry.id === plan.compactionEntryId)) return plan.compactionEntryId;
  throw new CodexImportError("COMPACTION_SOURCE_CHANGED", "Planned compaction entry ID now collides with the source");
}

/**
 * Append a Pi 0.82.1 compaction entry while preserving every original entry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function applySemanticCompaction(options: ApplySemanticCompactionOptions): SessionEntry[] {
  validateCompactionCoverage(options.plan, options.entries);
  if (options.plan.mode === "none") return [...options.entries];
  assertIdSequence(options.result.coveredEntryIds, options.plan.summaryEntryIds, "Summary result coverage does not match the plan");
  if (!options.result.summary.trim()) {
    throw new CodexImportError("SEMANTIC_SUMMARY_FAILED", "Cannot apply an empty semantic compaction summary");
  }
  const plan = options.plan as RuntimeSemanticCompactionPlan;
  const id = resolveCompactionId(plan, options.entries);
  const allFileOperations = [...new Set(options.result.nodes.flatMap((node) => node.fileOperations))].sort();
  const readFiles = allFileOperations.filter((operation) => operation.startsWith("read:")).map((operation) => operation.slice(5));
  const modifiedFiles = allFileOperations.filter((operation) => operation.startsWith("modified:")).map((operation) => operation.slice(9));
  const coverageManifest = coverageManifestForPlan(plan);
  const verifiedSummary = `${options.result.summary.trim()}\n\n${coverageManifest}`;
  const compaction = {
    type: "compaction" as const,
    id,
    parentId: options.entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    summary: verifiedSummary,
    firstKeptEntryId: options.plan.firstKeptEntryId ?? id,
    tokensBefore: options.plan.originalTokens,
    details: {
      version: 1,
      kind: "codex-import-semantic",
      planHash: options.plan.planHash,
      sourceVersion: options.plan.sourceVersion,
      compressionModel: `${options.plan.compressionModel.provider}/${options.plan.compressionModel.id}`,
      coveredEntryIds: [...options.result.coveredEntryIds],
      nodes: options.result.nodes,
      toolCallCount: options.result.nodes.at(-1)?.toolCallCount ?? 0,
      fileOperations: allFileOperations,
      readFiles,
      modifiedFiles,
    },
    usage: options.result.usage,
    fromHook: true,
  } as SessionEntry;
  return [...options.entries, compaction];
}
