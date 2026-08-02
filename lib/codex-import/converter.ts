import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, readFileSync, realpathSync, readSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type {
  ImageContent,
  ThinkingContent,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { CodexImportError } from "./errors";
import { isPathWithin, openRegularFileNoFollow } from "./filesystem";
import type {
  CodexImportWarning,
  CodexRolloutInspection,
  CodexSemanticHint,
  ConvertedPiSession,
} from "./types";

const MAX_JSONL_LINE_CHARS = 256 * 1024 * 1024;
const MAX_PORTABLE_IMAGE_BYTES = 20 * 1024 * 1024;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "incomplete"]);
const PAIRED_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "computer_call",
  "local_shell_call",
  "shell_call",
  "mcp_call",
  "mcp_tool_call",
]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

type JsonObject = Record<string, unknown>;
type AssistantBlock = TextContent | ThinkingContent | ToolCall;
type AppendPayload = Record<string, unknown>;

interface SourceRecord {
  lineNumber: number;
  type: string;
  timestamp?: unknown;
  payload: JsonObject;
}

interface ConvertCodexRolloutOptions {
  candidate: {
    id: string;
    name: string;
    archived: boolean;
    sourceKind: string;
    rolloutPath?: string;
  };
  inspection: CodexRolloutInspection;
  snapshotPath: string;
  targetCwd: string;
  sourceVersion: string;
  snapshotHash?: string;
  snapshotSize?: number;
  sessionId?: string;
  importedAt?: string;
}

interface EntryBuilder {
  entries: SessionEntry[];
  append(type: SessionEntry["type"], payload: AppendPayload, timestamp: string): string;
  lastId(): string | null;
}

interface WarningCollector {
  add(code: string, message: string): void;
  values(): CodexImportWarning[];
}

interface ScopeState {
  task: string;
  turn: string;
  taskOrdinal: number;
  userOrdinal: number;
}

interface SourceScan {
  canonicalAgentMessages: Set<string>;
  outputLinesByRawId: Map<string, number[]>;
  visibleUserCount: number;
}

interface ActiveCall {
  rawId: string;
  id: string;
  name: string;
}

interface ReadyToolResult {
  content: Array<TextContent | ImageContent>;
  isError: boolean;
}

interface SemanticTracker {
  observe(record: SourceRecord, previousEntryId: string | null): void;
  track(entryId: string): void;
  markFinal(lineNumber: number): void;
  finish(lineNumber: number): CodexSemanticHint[];
}

interface ConversionRuntime {
  builder: EntryBuilder;
  warnings: WarningCollector;
  semantic: SemanticTracker;
  activeCalls: Map<string, ActiveCall>;
  readyResults: Map<string, ReadyToolResult>;
  closedRawCallIds: Set<string>;
  usedCallIds: Set<string>;
  pendingBlocks: AssistantBlock[];
  pendingHasMessage: boolean;
  currentModel: string;
  currentThinking: string;
  persistedModel?: string;
  persistedThinking?: string;
  safeImageRoots: string[];
  toolNamePrefix: string;
  outputLinesByRawId: Map<string, number[]>;
}

/**
 * Parse one strict source line without exposing its body in errors.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function parseSourceLine(line: string, lineNumber: number): SourceRecord {
  if (!line.trim()) {
    throw new CodexImportError("MALFORMED_JSONL", `Empty Codex JSONL record at line ${lineNumber}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CodexImportError("MALFORMED_JSONL", `Malformed Codex JSONL record at line ${lineNumber}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexImportError("MALFORMED_JSONL", `Invalid Codex JSONL record at line ${lineNumber}`);
  }
  const object = value as JsonObject;
  const payload = object.payload && typeof object.payload === "object" && !Array.isArray(object.payload)
    ? object.payload as JsonObject
    : {};
  return {
    lineNumber,
    type: typeof object.type === "string" ? object.type : "",
    timestamp: object.timestamp,
    payload,
  };
}

/**
 * Stream strict LF-delimited Codex records from the immutable snapshot.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function* readSourceRecords(
  filePath: string,
  expectedHash?: string,
  expectedSize?: number,
): AsyncGenerator<SourceRecord> {
  const opened = openRegularFileNoFollow(filePath);
  const before = fstatSync(opened.fd);
  if (expectedSize !== undefined && before.size !== expectedSize) {
    closeSync(opened.fd);
    throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot length changed before conversion");
  }
  const decoder = new StringDecoder("utf8");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  let offset = 0;
  try {
    while (offset < before.size) {
      const bytesRead = readSync(opened.fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot was truncated during conversion");
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      pending += decoder.write(chunk);
      offset += bytesRead;
      if (pending.length > MAX_JSONL_LINE_CHARS && !pending.includes("\n")) {
        throw new CodexImportError("JSONL_LINE_TOO_LARGE", "A Codex JSONL record exceeds the safe import limit");
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lineNumber += 1;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line.length > MAX_JSONL_LINE_CHARS) {
          throw new CodexImportError("JSONL_LINE_TOO_LARGE", `Codex JSONL line ${lineNumber} is too large`);
        }
        yield parseSourceLine(line, lineNumber);
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.end();
    if (pending.trim()) {
      lineNumber += 1;
      if (pending.length > MAX_JSONL_LINE_CHARS) {
        throw new CodexImportError("JSONL_LINE_TOO_LARGE", `Codex JSONL line ${lineNumber} is too large`);
      }
      yield parseSourceLine(pending.replace(/\r$/, ""), lineNumber);
    }
    const after = fstatSync(opened.fd);
    const pathAfter = lstatSync(filePath);
    const changed = before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs;
    if (changed || (expectedHash !== undefined && digest.digest("hex") !== expectedHash)) {
      throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot changed during conversion");
    }
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Yield only records in the unique session_meta segment selected by SQLite thread ID.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function* readSelectedThreadRecords(options: ConvertCodexRolloutOptions): AsyncGenerator<SourceRecord> {
  let active = false;
  let matchingMetaCount = 0;
  for await (const record of readSourceRecords(options.snapshotPath, options.snapshotHash, options.snapshotSize)) {
    if (record.type === "session_meta") {
      const ids = [scalarString(record.payload.id), scalarString(record.payload.session_id)].filter(Boolean);
      active = ids.includes(options.candidate.id);
      if (active) matchingMetaCount += 1;
      continue;
    }
    if (active) yield record;
  }
  if (matchingMetaCount !== 1) {
    throw new CodexImportError(
      matchingMetaCount === 0 ? "SESSION_META_NOT_FOUND" : "AMBIGUOUS_SESSION_META",
      "Snapshot does not contain exactly one session metadata segment for the selected thread",
      { matchingSessionMetaCount: matchingMetaCount },
    );
  }
}

/**
 * Return a valid ISO timestamp or the supplied stable fallback.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function toIsoTimestamp(value: unknown, fallback: string): string {
  const milliseconds = Date.parse(typeof value === "string" ? value : "");
  return Number.isNaN(milliseconds) ? fallback : new Date(milliseconds).toISOString();
}

/**
 * Return zero usage without inventing billing or token accounting.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function emptyUsage(): Usage {
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
 * Build deterministic unique entry IDs and one strict parent chain.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createEntryBuilder(seed: string): EntryBuilder {
  const entries: SessionEntry[] = [];
  const ids = new Set<string>();
  let parentId: string | null = null;
  let sequence = 0;
  return {
    entries,
    /**
     * Append one entry to the linear branch.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    append(type, payload, timestamp) {
      let id = "";
      do {
        id = createHash("sha256").update(`${seed}:${sequence}`).digest("hex").slice(0, 8);
        sequence += 1;
      } while (ids.has(id));
      ids.add(id);
      entries.push({ type, id, parentId, timestamp, ...payload } as SessionEntry);
      parentId = id;
      return id;
    },
    /**
     * Return the current branch leaf.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    lastId() {
      return parentId;
    },
  };
}

/**
 * Aggregate warnings by stable code without retaining source text or identifiers.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createWarningCollector(): WarningCollector {
  const warnings = new Map<string, CodexImportWarning>();
  return {
    /**
     * Add or count one warning category.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    add(code, message) {
      const current = warnings.get(code);
      if (current) current.count = (current.count ?? 1) + 1;
      else warnings.set(code, { code, message });
    },
    /**
     * Return warnings in first-seen order.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    values() {
      return [...warnings.values()];
    },
  };
}

/**
 * Read a scalar source identifier without serializing arbitrary source data.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function scalarString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/**
 * Advance task/turn scope in the same way during both source passes.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function advanceScope(state: ScopeState, record: SourceRecord): string {
  const itemType = scalarString(record.payload.type) ?? "";
  if (record.type === "event_msg" && itemType === "task_started") {
    state.taskOrdinal += 1;
    state.userOrdinal = 0;
    state.task = scalarString(record.payload.task_id ?? record.payload.turn_id ?? record.payload.id)
      ?? `task-${state.taskOrdinal}`;
    state.turn = scalarString(record.payload.turn_id) ?? state.task;
  } else if (record.type === "turn_context") {
    state.turn = scalarString(record.payload.turn_id) ?? state.turn;
  } else if (record.type === "event_msg" && itemType === "user_message") {
    state.userOrdinal += 1;
    state.turn = scalarString(record.payload.turn_id) ?? (state.turn || `turn-${state.userOrdinal}`);
  }
  return `${state.task || "task-0"}:${state.turn || "turn-0"}:${state.userOrdinal}`;
}

/**
 * Extract only visible assistant text from one canonical or event item.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function extractAssistantText(payload: JsonObject): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter((block): block is JsonObject => Boolean(block) && typeof block === "object" && !Array.isArray(block))
    .filter((block) => ["output_text", "text"].includes(scalarString(block.type) ?? ""))
    .map((block) => scalarString(block.text) ?? "")
    .join("\n");
}

/**
 * Hash exact scoped text so the de-duplication index never stores message bodies.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function scopedTextHash(scope: string, text: string): string {
  return createHash("sha256").update(scope).update("\0").update(text).digest("hex");
}

/**
 * Identify portable call-output response items.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function isToolOutputType(type: string): boolean {
  return type === "tool_search_output" || type.endsWith("_call_output");
}

/**
 * Return whether an explicit user event carries visible text or an image reference.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function hasVisibleUserPayload(payload: JsonObject): boolean {
  if (extractVisibleUserText(payload).trim()) return true;
  return (Array.isArray(payload.images) && payload.images.length > 0)
    || (Array.isArray(payload.local_images) && payload.local_images.length > 0);
}

/**
 * Pre-index canonical assistant events and later tool outputs without message bodies.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function scanSource(options: ConvertCodexRolloutOptions): Promise<SourceScan> {
  const canonicalAgentMessages = new Set<string>();
  const outputLinesByRawId = new Map<string, number[]>();
  const scope: ScopeState = { task: "", turn: "", taskOrdinal: 0, userOrdinal: 0 };
  let visibleUserCount = 0;
  for await (const record of readSelectedThreadRecords(options)) {
    const scopeKey = advanceScope(scope, record);
    const type = scalarString(record.payload.type) ?? "";
    if (record.type === "event_msg" && type === "user_message" && hasVisibleUserPayload(record.payload)) {
      visibleUserCount += 1;
    }
    if (record.type === "response_item" && type === "message" && record.payload.role === "assistant") {
      const text = extractAssistantText(record.payload);
      if (text) canonicalAgentMessages.add(scopedTextHash(scopeKey, text));
    }
    if (record.type === "response_item" && isToolOutputType(type)) {
      const rawId = scalarString(record.payload.call_id ?? record.payload.id);
      if (!rawId) continue;
      const lines = outputLinesByRawId.get(rawId) ?? [];
      lines.push(record.lineNumber);
      outputLinesByRawId.set(rawId, lines);
    }
  }
  return { canonicalAgentMessages, outputLinesByRawId, visibleUserCount };
}

/**
 * Remove provider continuation secrets from retained structured values.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function scrubPrivateState(value: unknown, depth = 0): unknown {
  if (depth > 64) return "[nested value omitted]";
  if (Array.isArray(value)) return value.map((item) => scrubPrivateState(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (normalized.includes("encrypted") || normalized.endsWith("signature") || normalized === "responseid"
      || normalized === "previousresponseid") continue;
    output[key] = scrubPrivateState(child, depth + 1);
  }
  return output;
}

/**
 * Parse tool arguments while preserving malformed raw input as portable data.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function parseToolArguments(value: unknown): JsonObject {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }
  const scrubbed = scrubPrivateState(parsed);
  if (scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) return scrubbed as JsonObject;
  return scrubbed === undefined ? {} : { input: scrubbed };
}

/**
 * Normalize a portable tool name for broad Responses compatibility.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function normalizeToolName(value: unknown, fallback: string, prefix: string): string {
  const source = scalarString(value)?.trim() || fallback;
  const portable = source.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  return `${prefix}${portable}`.slice(0, 64);
}

/**
 * Allocate a valid collision-safe historical call ID.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function allocateCallId(rawId: string, fallbackIndex: number, usedIds: Set<string>): string {
  let base = rawId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64).replace(/_+$/, "");
  if (!base) base = `codex_call_${fallbackIndex}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate) || !CALL_ID_RE.test(candidate)) {
    const suffixText = `_${suffix}`;
    suffix += 1;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
  }
  usedIds.add(candidate);
  return candidate;
}

/**
 * Decode a bounded, non-scriptable inline image into a Pi image block.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function decodeDataImage(value: unknown): ImageContent | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) return undefined;
  const mimeType = match[1].toLowerCase();
  const data = match[2].replace(/\s/g, "");
  if (!IMAGE_MIME_TYPES.has(mimeType) || data.length === 0 || data.length % 4 === 1) return undefined;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PORTABLE_IMAGE_BYTES) return undefined;
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

/**
 * Detect supported local image bytes instead of trusting a source extension.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function detectImageMime(data: Buffer): string | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 2 && data.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

/**
 * Decode raw base64 image output when its bytes have a supported image signature.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function decodeRawBase64Image(value: unknown): ImageContent | undefined {
  if (typeof value !== "string" || value.length < 12 || !/^[A-Za-z0-9+/=\s]+$/.test(value)) return undefined;
  const data = Buffer.from(value.replace(/\s/g, ""), "base64");
  if (data.length === 0 || data.length > MAX_PORTABLE_IMAGE_BYTES) return undefined;
  const mimeType = detectImageMime(data);
  return mimeType ? { type: "image", mimeType, data: data.toString("base64") } : undefined;
}

/**
 * Read a bounded regular local image only when its real path stays in an allowed root.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readSafeLocalImage(reference: unknown, roots: string[]): ImageContent | undefined {
  const raw = typeof reference === "string" ? reference
    : reference && typeof reference === "object"
      ? scalarString((reference as JsonObject).path ?? (reference as JsonObject).image_url ?? (reference as JsonObject).url)
      : undefined;
  if (!raw || /^https?:/i.test(raw)) return undefined;
  const inline = decodeDataImage(raw);
  if (inline) return inline;
  let candidate: string;
  try {
    candidate = raw.startsWith("file:") ? fileURLToPath(raw) : isAbsolute(raw) ? raw : resolve(roots[0] ?? "", raw);
    if (!existsSync(candidate)) return undefined;
    const realCandidate = realpathSync.native(candidate);
    const allowed = roots.some((root) => {
      try {
        return isPathWithin(realCandidate, realpathSync.native(root));
      } catch {
        return false;
      }
    });
    if (!allowed) return undefined;
    const opened = openRegularFileNoFollow(candidate);
    try {
      const descriptorStats = fstatSync(opened.fd);
      const openedRealPath = realpathSync.native(candidate);
      const stillAllowed = roots.some((root) => {
        try {
          return isPathWithin(openedRealPath, realpathSync.native(root));
        } catch {
          return false;
        }
      });
      if (!stillAllowed || !descriptorStats.isFile()
        || descriptorStats.dev !== opened.stats.dev || descriptorStats.ino !== opened.stats.ino
        || descriptorStats.size <= 0 || descriptorStats.size > MAX_PORTABLE_IMAGE_BYTES) return undefined;
      const data = readFileSync(opened.fd);
      const mimeType = detectImageMime(data);
      return mimeType ? { type: "image", mimeType, data: data.toString("base64") } : undefined;
    } finally {
      closeSync(opened.fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Extract visible user text from the explicit UI event only.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function extractVisibleUserText(payload: JsonObject): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;
  const content = Array.isArray(payload.message) ? payload.message : payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .filter((item) => ["input_text", "text"].includes(scalarString(item.type) ?? ""))
    .map((item) => scalarString(item.text) ?? "")
    .join("\n");
}

/**
 * Convert one explicit visible user event, retaining only safe portable images.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function convertVisibleUserContent(
  payload: JsonObject,
  roots: string[],
  warnings: WarningCollector,
): string | Array<TextContent | ImageContent> {
  const text = extractVisibleUserText(payload);
  const references = [
    ...(Array.isArray(payload.images) ? payload.images : []),
    ...(Array.isArray(payload.local_images) ? payload.local_images : []),
  ];
  if (references.length === 0) return text;
  const content: Array<TextContent | ImageContent> = text ? [{ type: "text", text }] : [];
  for (const reference of references) {
    const image = decodeDataImage(typeof reference === "string" ? reference : (reference as JsonObject)?.image_url)
      ?? readSafeLocalImage(reference, roots);
    if (image) content.push(image);
    else warnings.add("IMAGE_OMITTED", "A non-portable or unsafe Codex image reference was omitted");
  }
  if (content.length === 0) content.push({ type: "text", text: "[Codex visible user content omitted for safety]" });
  return content;
}

/**
 * Convert source output into bounded portable Pi text and image blocks.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function convertToolOutput(value: unknown, roots: string[], warnings: WarningCollector): Array<TextContent | ImageContent> {
  const inline = decodeDataImage(value) ?? decodeRawBase64Image(value) ?? readSafeLocalImage(value, roots);
  if (inline) return [inline];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    const objectImage = decodeDataImage(object.image_url ?? object.url ?? object.result ?? object.data)
      ?? decodeRawBase64Image(object.result ?? object.data)
      ?? readSafeLocalImage(object, roots);
    if (objectImage) return [objectImage];
  }
  if (Array.isArray(value)) {
    const blocks: Array<TextContent | ImageContent> = [];
    for (const item of value) {
      if (typeof item === "string") blocks.push({ type: "text", text: item });
      else if (item && typeof item === "object") {
        const object = item as JsonObject;
        const type = scalarString(object.type) ?? "";
        if (["input_text", "output_text", "text"].includes(type) && typeof object.text === "string") {
          blocks.push({ type: "text", text: object.text });
        } else if (["input_image", "output_image", "image"].includes(type)) {
          const image = decodeDataImage(object.image_url ?? object.url ?? object.result ?? object.data)
            ?? decodeRawBase64Image(object.result ?? object.data)
            ?? readSafeLocalImage(object, roots);
          if (image) blocks.push(image);
          else warnings.add("IMAGE_OMITTED", "A non-portable or unsafe Codex tool image was omitted");
        } else {
          blocks.push({ type: "text", text: JSON.stringify(scrubPrivateState(object)) });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ type: "text", text: "[Codex tool returned no portable content]" }];
  }
  const portable = scrubPrivateState(value ?? null);
  return [{ type: "text", text: JSON.stringify(portable) ?? String(portable) }];
}

/**
 * Normalize a Pi-supported thinking level.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function normalizeThinkingLevel(value: unknown): string {
  const normalized = scalarString(value)?.toLowerCase() ?? "off";
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)
    ? normalized
    : "off";
}

/**
 * Create task, visible-turn, and compacted-boundary semantic hints.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createSemanticTracker(): SemanticTracker {
  const hints: CodexSemanticHint[] = [];
  const usedKeys = new Set<string>();
  let activeTask: CodexSemanticHint | undefined;
  let activeTurn: CodexSemanticHint | undefined;
  let pendingBoundary: CodexSemanticHint | undefined;
  let taskOrdinal = 0;
  let turnOrdinal = 0;
  let compactionOrdinal = 0;
  /**
   * Allocate a stable unique hint key.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const uniqueKey = (base: string): string => {
    let key = base;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${base}-${suffix++}`;
    usedKeys.add(key);
    return key;
  };
  /**
   * Add an entry to one hint without adjacent duplicates.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const include = (hint: CodexSemanticHint | undefined, id: string): void => {
    if (hint && hint.entryIds.at(-1) !== id) hint.entryIds.push(id);
  };
  return {
    /**
     * Observe one source boundary before converting its content.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    observe(record, previousEntryId) {
      const type = scalarString(record.payload.type) ?? "";
      if (record.type === "event_msg" && type === "task_started") {
        if (activeTask && activeTask.sourceEndLine === undefined) activeTask.sourceEndLine = record.lineNumber - 1;
        if (activeTurn && activeTurn.sourceEndLine === undefined) activeTurn.sourceEndLine = record.lineNumber - 1;
        activeTurn = undefined;
        taskOrdinal += 1;
        activeTask = {
          key: uniqueKey(`task:${scalarString(record.payload.task_id ?? record.payload.turn_id) ?? taskOrdinal}`),
          kind: "task",
          entryIds: [],
          complete: false,
          sourceStartLine: record.lineNumber,
        };
        hints.push(activeTask);
      } else if (record.type === "event_msg" && type === "user_message") {
        if (activeTurn) {
          activeTurn.complete = true;
          activeTurn.sourceEndLine = record.lineNumber - 1;
        }
        turnOrdinal += 1;
        activeTurn = {
          key: activeTask?.key ?? uniqueKey(`turn:${scalarString(record.payload.turn_id) ?? turnOrdinal}`),
          kind: "turn",
          entryIds: [],
          complete: false,
          sourceStartLine: record.lineNumber,
        };
        hints.push(activeTurn);
      } else if (record.type === "event_msg" && type === "task_complete") {
        if (activeTask) {
          activeTask.complete = true;
          activeTask.sourceEndLine = record.lineNumber;
        }
        if (activeTurn) {
          activeTurn.complete = true;
          activeTurn.sourceEndLine = record.lineNumber;
        }
      }
      if (record.type === "compacted" || type === "compacted" || type === "context_compacted") {
        compactionOrdinal += 1;
        pendingBoundary = {
          key: uniqueKey(`compaction:${compactionOrdinal}`),
          kind: "compaction-boundary",
          entryIds: previousEntryId ? [previousEntryId] : [],
          complete: true,
          sourceStartLine: record.lineNumber,
          sourceEndLine: record.lineNumber,
        };
        hints.push(pendingBoundary);
      }
    },
    /**
     * Attach one converted entry to active hints.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    track(entryId) {
      include(activeTask, entryId);
      include(activeTurn, entryId);
      include(pendingBoundary, entryId);
      pendingBoundary = undefined;
    },
    /**
     * Mark a visible turn complete on a canonical final answer.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    markFinal(lineNumber) {
      if (activeTurn) {
        activeTurn.complete = true;
        activeTurn.sourceEndLine = lineNumber;
      }
    },
    /**
     * Finalize source ranges while preserving incomplete-boundary state.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    finish(lineNumber) {
      if (activeTask && activeTask.sourceEndLine === undefined) activeTask.sourceEndLine = lineNumber;
      if (activeTurn && activeTurn.sourceEndLine === undefined) activeTurn.sourceEndLine = lineNumber;
      return hints;
    },
  };
}

/**
 * Append one source-derived entry and attach it to active semantic hints.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendSourceEntry(
  runtime: ConversionRuntime,
  type: SessionEntry["type"],
  payload: AppendPayload,
  timestamp: string,
): string {
  const id = runtime.builder.append(type, payload, timestamp);
  runtime.semantic.track(id);
  return id;
}

/**
 * Persist accumulated assistant blocks as one signature-free Pi message.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function flushAssistant(runtime: ConversionRuntime, timestamp: string): string | undefined {
  if (runtime.pendingBlocks.length === 0) return undefined;
  const content = runtime.pendingBlocks;
  const hasCalls = content.some((block) => block.type === "toolCall");
  runtime.pendingBlocks = [];
  runtime.pendingHasMessage = false;
  return appendSourceEntry(runtime, "message", {
    message: {
      role: "assistant",
      content,
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: runtime.currentModel,
      usage: emptyUsage(),
      stopReason: hasCalls ? "toolUse" : "stop",
      timestamp: Date.parse(timestamp),
    },
  }, timestamp);
}

/**
 * Append exactly one result for a converted call.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendToolResult(
  runtime: ConversionRuntime,
  call: ActiveCall,
  content: Array<TextContent | ImageContent>,
  isError: boolean,
  timestamp: string,
  synthetic: boolean,
): void {
  appendSourceEntry(runtime, "message", {
    message: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
      timestamp: Date.parse(timestamp),
      ...(synthetic ? { details: { codexImport: { synthetic: true, reason: "missing-output" } } } : {}),
    },
  }, timestamp);
}

/**
 * Close every interrupted active call before the next conversation message.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function closePendingCalls(runtime: ConversionRuntime, timestamp: string): void {
  flushAssistant(runtime, timestamp);
  appendReadyToolResults(runtime, timestamp);
  for (const call of runtime.activeCalls.values()) {
    appendToolResult(
      runtime,
      call,
      [{ type: "text", text: "[Codex tool result missing: the source turn ended before output was recorded]" }],
      true,
      timestamp,
      true,
    );
    runtime.closedRawCallIds.add(call.rawId);
    runtime.warnings.add(
      "SYNTHETIC_TOOL_RESULT",
      "An interrupted Codex tool call was closed with an explicit synthetic error result",
    );
  }
  runtime.activeCalls.clear();
}

/**
 * Append terminal server-side results after their shared assistant call message.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendReadyToolResults(runtime: ConversionRuntime, timestamp: string): void {
  for (const [rawId, ready] of runtime.readyResults) {
    const call = runtime.activeCalls.get(rawId);
    if (!call) continue;
    appendToolResult(runtime, call, ready.content, ready.isError, timestamp, false);
    runtime.activeCalls.delete(rawId);
    runtime.closedRawCallIds.add(rawId);
  }
  runtime.readyResults.clear();
}

/**
 * Append changed model and thinking settings at a source turn boundary.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendTurnSettings(runtime: ConversionRuntime, payload: JsonObject, timestamp: string): void {
  const model = scalarString(payload.model) ?? runtime.currentModel;
  const thinking = normalizeThinkingLevel(payload.effort ?? payload.reasoning_effort ?? runtime.currentThinking);
  if (model !== runtime.persistedModel) {
    appendSourceEntry(runtime, "model_change", { provider: "openai-codex", modelId: model }, timestamp);
    runtime.persistedModel = model;
  }
  if (thinking !== runtime.persistedThinking) {
    appendSourceEntry(runtime, "thinking_level_change", { thinkingLevel: thinking }, timestamp);
    runtime.persistedThinking = thinking;
  }
  runtime.currentModel = model;
  runtime.currentThinking = thinking;
}

/**
 * Extract portable canonical assistant text blocks without continuation state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function canonicalAssistantBlocks(payload: JsonObject): TextContent[] {
  if (!Array.isArray(payload.content)) {
    const text = extractAssistantText(payload);
    return text ? [{ type: "text", text }] : [];
  }
  return payload.content.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as JsonObject;
    const type = scalarString(block.type) ?? "";
    return ["output_text", "text"].includes(type) && typeof block.text === "string"
      ? [{ type: "text" as const, text: block.text }]
      : [];
  });
}

/**
 * Append one canonical or fallback assistant message at a safe boundary.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendAssistantItem(
  runtime: ConversionRuntime,
  blocks: TextContent[],
  phase: unknown,
  timestamp: string,
  lineNumber: number,
): void {
  if (blocks.length === 0) return;
  if (runtime.activeCalls.size > 0) closePendingCalls(runtime, timestamp);
  else if (runtime.pendingHasMessage) flushAssistant(runtime, timestamp);
  runtime.pendingBlocks.push(...blocks);
  runtime.pendingHasMessage = true;
  if (phase === "final_answer") {
    flushAssistant(runtime, timestamp);
    runtime.semantic.markFinal(lineNumber);
  }
}

/**
 * Extract visible reasoning summaries while excluding encrypted reasoning state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendReasoningSummary(runtime: ConversionRuntime, payload: JsonObject, timestamp: string): void {
  if (runtime.activeCalls.size > 0) closePendingCalls(runtime, timestamp);
  const summaries = Array.isArray(payload.summary) ? payload.summary : [];
  const thinking = summaries.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as JsonObject;
    return ["summary_text", "text", "output_text"].includes(scalarString(block.type) ?? "")
      && typeof block.text === "string" ? [block.text] : [];
  }).join("\n\n");
  if (thinking) runtime.pendingBlocks.push({ type: "thinking", thinking });
}

/**
 * Return portable call arguments for known and future Responses call items.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function callArguments(payload: JsonObject, type: string): JsonObject {
  if (type === "function_call") return parseToolArguments(payload.arguments);
  if (type === "custom_tool_call") return parseToolArguments(payload.input);
  if (payload.arguments !== undefined) return parseToolArguments(payload.arguments);
  if (payload.input !== undefined) return parseToolArguments(payload.input);
  if (payload.action !== undefined) return parseToolArguments(payload.action);
  const ignored = new Set(["type", "call_id", "id", "name", "status", "output", "result", "results"]);
  const compact: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!ignored.has(key)) compact[key] = value;
  }
  return parseToolArguments(compact);
}

/**
 * Return whether a source call has an explicit output later in the rollout.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function hasLaterOutput(runtime: ConversionRuntime, rawId: string, lineNumber: number): boolean {
  return (runtime.outputLinesByRawId.get(rawId) ?? []).some((line) => line > lineNumber);
}

/**
 * Append one canonical call, pairing terminal server-side calls immediately.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendCall(runtime: ConversionRuntime, payload: JsonObject, type: string, timestamp: string, lineNumber: number): void {
  const rawId = scalarString(payload.call_id ?? payload.id) ?? `missing-call-id-${lineNumber}`;
  if (runtime.activeCalls.has(rawId)) {
    throw new CodexImportError(
      "DUPLICATE_ACTIVE_TOOL_CALL_ID",
      "A Codex rollout reused a tool call ID before the active call was closed",
    );
  }
  if (runtime.activeCalls.size > 0 && runtime.pendingBlocks.length === 0) closePendingCalls(runtime, timestamp);
  const id = allocateCallId(rawId, runtime.usedCallIds.size + 1, runtime.usedCallIds);
  const fallbackName = type.replace(/_call$/, "") || "codex_tool";
  const call: ActiveCall = {
    rawId,
    id,
    name: normalizeToolName(payload.name, fallbackName, runtime.toolNamePrefix),
  };
  runtime.activeCalls.set(rawId, call);
  runtime.pendingBlocks.push({ type: "toolCall", id, name: call.name, arguments: callArguments(payload, type) });

  const status = scalarString(payload.status)?.toLowerCase() ?? "";
  const hasOwnResult = Object.hasOwn(payload, "result") || Object.hasOwn(payload, "output")
    || Object.hasOwn(payload, "results");
  const serverSideTerminal = !PAIRED_CALL_TYPES.has(type) && TERMINAL_STATUSES.has(status);
  if (!hasLaterOutput(runtime, rawId, lineNumber) && (hasOwnResult || serverSideTerminal)) {
    const output = payload.output ?? payload.result ?? payload.results ?? payload.error
      ?? { status: status || "completed", sourceType: type };
    runtime.readyResults.set(rawId, {
      content: convertToolOutput(output, runtime.safeImageRoots, runtime.warnings),
      isError: status === "failed" || payload.error !== undefined,
    });
  }
}

/**
 * Pair one canonical output with its active call or issue an explicit safe warning.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendCallOutput(runtime: ConversionRuntime, payload: JsonObject, timestamp: string): void {
  const rawId = scalarString(payload.call_id ?? payload.id);
  const call = rawId ? runtime.activeCalls.get(rawId) : undefined;
  if (!call) {
    const late = Boolean(rawId && runtime.closedRawCallIds.has(rawId));
    runtime.warnings.add(
      late ? "LATE_TOOL_OUTPUT" : "ORPHAN_TOOL_OUTPUT",
      late
        ? "A late Codex tool output was skipped because its call was already closed"
        : "An orphan Codex tool output was skipped because no active call is available",
    );
    return;
  }
  flushAssistant(runtime, timestamp);
  appendReadyToolResults(runtime, timestamp);
  const output = payload.output ?? payload.result ?? payload.tools ?? payload.content ?? payload.error ?? null;
  const status = scalarString(payload.status)?.toLowerCase();
  appendToolResult(
    runtime,
    call,
    convertToolOutput(output, runtime.safeImageRoots, runtime.warnings),
    status === "failed" || payload.error !== undefined,
    timestamp,
    false,
  );
  runtime.activeCalls.delete(rawId!);
  runtime.closedRawCallIds.add(rawId!);
}

/**
 * Convert one canonical Responses item into portable Pi history.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function handleResponseItem(runtime: ConversionRuntime, record: SourceRecord, timestamp: string): void {
  const payload = record.payload;
  const type = scalarString(payload.type) ?? "";
  if (type === "message") {
    if (payload.role !== "assistant") return;
    appendAssistantItem(
      runtime,
      canonicalAssistantBlocks(payload),
      payload.phase,
      timestamp,
      record.lineNumber,
    );
  } else if (type === "reasoning") {
    appendReasoningSummary(runtime, payload, timestamp);
  } else if (isToolOutputType(type)) {
    appendCallOutput(runtime, payload, timestamp);
  } else if (type.endsWith("_call")) {
    appendCall(runtime, payload, type, timestamp, record.lineNumber);
  }
}

/**
 * Return existing safe image roots used by local image containment checks.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function collectSafeImageRoots(options: ConvertCodexRolloutOptions): string[] {
  const values = [
    options.targetCwd,
    options.inspection.initialCwd,
    options.inspection.effectiveCwd,
    ...options.inspection.workspaceRoots,
  ];
  return [...new Set(
    values
      .filter((value) => typeof value === "string" && value && existsSync(value))
      .map((value) => resolve(value)),
  )];
}

/**
 * Convert an immutable top-level Codex rollout into a portable linear Pi v3 session.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function convertCodexRollout(options: ConvertCodexRolloutOptions): Promise<ConvertedPiSession> {
  const { candidate, inspection } = options;
  if (candidate.sourceKind !== "root" || inspection.sourceKind !== "root") {
    throw new CodexImportError("NON_ROOT_SESSION_REJECTED", "Only top-level Codex sessions can be imported");
  }
  const scan = await scanSource(options);
  if (scan.visibleUserCount === 0) {
    throw new CodexImportError(
      "NO_VISIBLE_USER_MESSAGE",
      "The Codex rollout has no explicit visible user_message event",
    );
  }

  const sessionId = options.sessionId ?? randomUUID();
  const createdAt = toIsoTimestamp(inspection.createdAt, new Date().toISOString());
  const builder = createEntryBuilder(`${candidate.id}:${sessionId}`);
  const warnings = createWarningCollector();
  const semantic = createSemanticTracker();
  const provenance: Record<string, unknown> = {
    version: 1,
    sourceThreadId: candidate.id,
    sourceSessionId: inspection.sourceSessionId,
    sourceVersion: options.sourceVersion,
    sourceKind: inspection.sourceKind,
    originalCwd: inspection.effectiveCwd,
    workspaceRoots: [...inspection.workspaceRoots],
    sandboxWritableRoots: [...inspection.sandboxWritableRoots],
    archived: candidate.archived,
    importedAt: options.importedAt ?? new Date().toISOString(),
    warnings: [],
    semanticHintCount: 0,
  };
  builder.append("session_info", { name: candidate.name }, createdAt);
  builder.append("custom", { customType: "codex-import", data: provenance }, createdAt);

  const runtime: ConversionRuntime = {
    builder,
    warnings,
    semantic,
    activeCalls: new Map(),
    readyResults: new Map(),
    closedRawCallIds: new Set(),
    usedCallIds: new Set(),
    pendingBlocks: [],
    pendingHasMessage: false,
    currentModel: inspection.model || "codex-imported",
    currentThinking: normalizeThinkingLevel(inspection.reasoningEffort),
    safeImageRoots: collectSafeImageRoots(options),
    toolNamePrefix: `codex_${createHash("sha256").update(candidate.id).digest("hex").slice(0, 10)}_`,
    outputLinesByRawId: scan.outputLinesByRawId,
  };
  const scope: ScopeState = { task: "", turn: "", taskOrdinal: 0, userOrdinal: 0 };
  const seenFallbackAgentMessages = new Set<string>();
  let lastTimestamp = createdAt;
  let lastLine = 0;

  for await (const record of readSelectedThreadRecords(options)) {
    lastLine = record.lineNumber;
    const scopeKey = advanceScope(scope, record);
    const timestamp = toIsoTimestamp(record.timestamp, lastTimestamp);
    lastTimestamp = timestamp;
    const itemType = scalarString(record.payload.type) ?? "";
    const compactionBoundary = record.type === "compacted" || itemType === "compacted"
      || itemType === "context_compacted";
    const closesPriorPhase = record.type === "turn_context" || compactionBoundary
      || (record.type === "event_msg" && ["task_started", "task_complete", "user_message"].includes(itemType));
    if (closesPriorPhase) {
      if (runtime.activeCalls.size > 0) closePendingCalls(runtime, timestamp);
      else flushAssistant(runtime, timestamp);
    }
    semantic.observe(record, builder.lastId());

    if (record.type === "turn_context") {
      appendTurnSettings(runtime, record.payload, timestamp);
    } else if (compactionBoundary) {
      warnings.add("CODEX_COMPACTION_BOUNDARY", "A Codex compaction boundary was retained as a semantic hint");
    } else if (record.type === "event_msg" && itemType === "user_message") {
      appendSourceEntry(runtime, "message", {
        message: {
          role: "user",
          content: convertVisibleUserContent(record.payload, runtime.safeImageRoots, warnings),
          timestamp: Date.parse(timestamp),
        },
      }, timestamp);
    } else if (record.type === "event_msg" && itemType === "agent_message") {
      const text = extractAssistantText(record.payload);
      const exactHash = text ? scopedTextHash(scopeKey, text) : "";
      if (exactHash && !scan.canonicalAgentMessages.has(exactHash) && !seenFallbackAgentMessages.has(exactHash)) {
        seenFallbackAgentMessages.add(exactHash);
        appendAssistantItem(runtime, [{ type: "text", text }], record.payload.phase, timestamp, record.lineNumber);
      }
    } else if (record.type === "response_item") {
      handleResponseItem(runtime, record, timestamp);
    }
  }

  if (runtime.activeCalls.size > 0) closePendingCalls(runtime, lastTimestamp);
  else flushAssistant(runtime, lastTimestamp);
  const semanticHints = semantic.finish(lastLine);
  const convertedWarnings = warnings.values();
  provenance.warnings = convertedWarnings;
  provenance.semanticHintCount = semanticHints.length;
  return {
    header: { type: "session", version: 3, id: sessionId, timestamp: createdAt, cwd: options.targetCwd },
    entries: builder.entries,
    warnings: convertedWarnings,
    semanticHints,
    provenance,
  };
}

/**
 * Serialize a converted Pi v3 session as strict trailing-newline JSONL.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function serializeConvertedPiSession(conversion: ConvertedPiSession): string {
  return `${[conversion.header, ...conversion.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
