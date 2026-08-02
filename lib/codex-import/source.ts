import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CodexImportError } from "./errors";
import {
  assertExistingPathWithin,
  assertNoLinkedPathComponents,
  ensureSecureDirectory,
  isPathWithin,
  normalizePathForComparison,
  openRegularFileNoFollow,
} from "./filesystem";
import { readStrictCodexJsonl } from "./jsonl";
import { getCodexImportState } from "./storage";
import type {
  CodexCandidate,
  CodexCandidateFilters,
  CodexImportWarning,
  CodexRolloutInspection,
  CodexRolloutSnapshot,
  CodexThreadKind,
  CodexThreadSourceSignals,
} from "./types";

interface InspectCodexRolloutOptions {
  threadId: string;
  rolloutPath: string;
  sqliteSource?: unknown;
  sqliteThreadSource?: unknown;
  sqliteAgentRole?: unknown;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  expectedSnapshotHash?: string;
  expectedSnapshotSize?: number;
}

interface ListCodexCandidatesOptions {
  codexHome: string;
  agentDir: string;
  filters?: CodexCandidateFilters;
}

interface CreateRolloutSnapshotOptions {
  sourcePath: string;
  codexHome: string;
  agentDir: string;
  threadId: string;
  maxAttempts?: number;
  onSourceChunk?: (chunk: Uint8Array) => void;
}

type SqliteRow = Record<string, unknown>;

const SNAPSHOT_CHUNK_SIZE = 256 * 1024;
const MAX_METADATA_PATHS = 32;
const MAX_METADATA_PATH_CHARS = 1_024;
const ROOT_SOURCE_NAMES = new Set(["cli", "exec", "user", "vscode", "api", "app", "root", "primary"]);
const THREAD_METADATA_COLUMNS = new Set([
  "id",
  "rollout_path",
  "source",
  "thread_source",
  "agent_role",
  "model_provider",
  "model",
  "reasoning_effort",
  "name",
  "title",
  "cwd",
  "sandbox_policy",
  "archived",
  "archived_at",
  "created_at_ms",
  "created_at",
  "updated_at_ms",
  "updated_at",
  "recency_at_ms",
  "recency_at",
  "cli_version",
]);

/**
 * Narrow an unknown JSON value to an object record.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Return a non-empty string without coercing private data.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Return one bounded filesystem metadata string.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function asPathString(value: unknown): string {
  const path = asString(value);
  return path.length <= MAX_METADATA_PATH_CHARS ? path : "";
}

/**
 * Decode a source signal that may be stored as JSON text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function decodeSourceSignal(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\"")) {
    return trimmed.toLowerCase();
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Collect normalized metadata tokens from a bounded source object.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function collectSignalTokens(value: unknown, tokens: Set<string>, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    for (const token of value.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean)) tokens.add(token);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSignalTokens(item, tokens, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    tokens.add(key.toLowerCase());
    collectSignalTokens(child, tokens, depth + 1);
  }
}

/**
 * Classify a Codex thread using only explicit source metadata, never names or transcript text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function classifyCodexThreadSource(signals: CodexThreadSourceSignals): CodexThreadKind {
  const tokens = new Set<string>();
  for (const raw of [
    signals.source,
    signals.threadSource,
    signals.agentRole,
    signals.rolloutSource,
    signals.rolloutThreadSource,
  ]) collectSignalTokens(decodeSourceSignal(raw), tokens);

  if (tokens.has("guardian")) return "guardian";
  if (tokens.has("subagent") || tokens.has("thread_spawn") || tokens.has("parent_thread_id")) return "subagent";
  if ([...ROOT_SOURCE_NAMES].some((name) => tokens.has(name))) return "root";
  return "unknown";
}

/**
 * Read an array of path strings while keeping workspace and sandbox sources separate.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readPathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (paths.length >= MAX_METADATA_PATHS) break;
    const path = asString(item);
    if (!path || path.length > MAX_METADATA_PATH_CHARS) continue;
    const key = normalizePathForComparison(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
}

/**
 * Read writable roots from a dynamically available SQLite sandbox policy.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readSandboxPolicyRoots(value: unknown): string[] {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return readPathArray(asRecord(decoded)?.writable_roots);
}

/**
 * Append unique paths without merging workspace roots with writable sandbox roots.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function appendUniquePaths(target: string[], values: string[]): void {
  const seen = new Set(target.map(normalizePathForComparison));
  for (const value of values) {
    if (target.length >= MAX_METADATA_PATHS) break;
    if (value.length > MAX_METADATA_PATH_CHARS) continue;
    const key = normalizePathForComparison(value);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(value);
  }
}

/**
 * Estimate visible text size for list metadata without retaining or returning transcript text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function countTextCharacters(value: unknown, depth = 0): number {
  if (depth > 12 || value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countTextCharacters(item, depth + 1), 0);
  const record = asRecord(value);
  if (!record) return 0;
  let total = 0;
  for (const item of Object.values(record)) total += countTextCharacters(item, depth + 1);
  return total;
}

/**
 * Extract the latest authoritative token total from a Codex event when present.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readTokenTotal(payload: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [payload.total_tokens, payload.tokens_used];
  const info = asRecord(payload.info);
  const usage = asRecord(info?.total_token_usage) ?? asRecord(payload.usage);
  candidates.push(usage?.total_tokens, usage?.input_tokens, usage?.output_tokens);
  for (const candidate of candidates.slice(0, 3)) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const total = Number(candidate);
    if (Number.isFinite(total) && total >= 0) return total;
  }
  const input = Number(candidates[3]);
  const output = Number(candidates[4]);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? input + output : undefined;
}

/**
 * Add a warning once by code.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function addWarning(warnings: CodexImportWarning[], code: string, message: string): void {
  if (!warnings.some((warning) => warning.code === code)) warnings.push({ code, message });
}

/**
 * Inspect only records belonging to the session_meta whose id matches the authoritative thread id.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function inspectCodexRollout(options: InspectCodexRolloutOptions): Promise<CodexRolloutInspection> {
  let selectedMeta: { payload: Record<string, unknown>; timestamp: string } | undefined;
  let matchingSessionMetaCount = 0;
  let active = false;
  let recordCount = 0;
  let visibleUserCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let codexCompactionCount = 0;
  let estimatedCharacters = 0;
  let authoritativeTokens: number | undefined;
  let effectiveCwd = "";
  let modelProvider = options.modelProvider ?? "";
  let model = options.model ?? "";
  let reasoningEffort = options.reasoningEffort ?? "";
  let contextWindow: number | undefined;
  const workspaceRoots: string[] = [];
  const sandboxWritableRoots: string[] = [];
  const warnings: CodexImportWarning[] = [];

  const expectedSnapshot = options.expectedSnapshotHash !== undefined && options.expectedSnapshotSize !== undefined
    ? { hash: options.expectedSnapshotHash, size: options.expectedSnapshotSize }
    : undefined;
  for await (const record of readStrictCodexJsonl(options.rolloutPath, expectedSnapshot)) {
    const payload = asRecord(record.payload) ?? {};
    if (record.type === "session_meta") {
      const ids = [asString(payload.id), asString(payload.session_id)].filter(Boolean);
      active = ids.includes(options.threadId);
      if (!active) continue;
      matchingSessionMetaCount += 1;
      recordCount += 1;
      if (!selectedMeta) {
        selectedMeta = { payload, timestamp: asString(payload.timestamp) || asString(record.timestamp) };
        effectiveCwd = asPathString(payload.cwd);
        modelProvider = asString(payload.model_provider) || modelProvider;
        const metaWindow = Number(payload.context_window);
        if (Number.isFinite(metaWindow) && metaWindow > 0) contextWindow = metaWindow;
      }
      continue;
    }
    if (!active) continue;

    recordCount += 1;
    const payloadType = asString(payload.type);
    if (record.type === "turn_context") {
      const latestCwd = asPathString(payload.cwd);
      if (latestCwd) effectiveCwd = latestCwd;
      appendUniquePaths(workspaceRoots, readPathArray(payload.workspace_roots));
      const sandboxPolicy = asRecord(payload.sandbox_policy);
      appendUniquePaths(sandboxWritableRoots, readPathArray(sandboxPolicy?.writable_roots));
      modelProvider = asString(payload.model_provider) || modelProvider;
      model = asString(payload.model) || model;
      reasoningEffort = asString(payload.effort) || asString(payload.reasoning_effort) || reasoningEffort;
    }
    if (record.type === "event_msg" && payloadType === "user_message") {
      visibleUserCount += 1;
      estimatedCharacters += countTextCharacters(payload.message) + countTextCharacters(payload.images);
    }
    if (record.type === "response_item" && payloadType === "message" && payload.role === "assistant") {
      assistantCount += 1;
      estimatedCharacters += countTextCharacters(payload.content);
    }
    if (record.type === "response_item" && /(?:^|_)call$/.test(payloadType)) toolCallCount += 1;
    if (record.type === "response_item" && /(?:^|_)call_output$/.test(payloadType)) toolResultCount += 1;
    if (record.type === "compacted" || payloadType === "compaction" || payloadType === "context_compacted") {
      codexCompactionCount += 1;
    }
    const tokenTotal = readTokenTotal(payload);
    if (tokenTotal !== undefined) authoritativeTokens = tokenTotal;
    const windowValue = Number(payload.model_context_window ?? asRecord(payload.info)?.model_context_window);
    if (Number.isFinite(windowValue) && windowValue > 0) contextWindow = windowValue;
  }

  if (!selectedMeta) {
    throw new CodexImportError("SESSION_META_NOT_FOUND", "Rollout does not contain session metadata for the selected thread");
  }
  if (matchingSessionMetaCount !== 1) {
    throw new CodexImportError("AMBIGUOUS_SESSION_META", "Rollout contains multiple matching session metadata records", {
      matchingSessionMetaCount,
    });
  }

  const initialCwd = asPathString(selectedMeta.payload.cwd);
  if (!effectiveCwd) effectiveCwd = initialCwd;
  if (workspaceRoots.length === 0 && initialCwd) workspaceRoots.push(initialCwd);
  if (!effectiveCwd) addWarning(warnings, "MISSING_CWD", "The source cwd is missing and must be remapped");
  const sourceKind = classifyCodexThreadSource({
    source: options.sqliteSource,
    threadSource: options.sqliteThreadSource,
    agentRole: [options.sqliteAgentRole, selectedMeta.payload.agent_role],
    rolloutSource: selectedMeta.payload.source,
    rolloutThreadSource: selectedMeta.payload.thread_source,
  });
  if (sourceKind === "unknown") addWarning(warnings, "UNKNOWN_SOURCE_KIND", "The Codex source kind is unknown");

  return {
    threadId: options.threadId,
    sourceSessionId: [asString(selectedMeta.payload.id), asString(selectedMeta.payload.session_id)]
      .find((id) => id === options.threadId) ?? options.threadId,
    sourceKind,
    matchingSessionMetaCount,
    createdAt: asString(selectedMeta.payload.timestamp) || selectedMeta.timestamp || new Date(0).toISOString(),
    initialCwd,
    effectiveCwd,
    workspaceRoots,
    sandboxWritableRoots,
    modelProvider: asString(selectedMeta.payload.model_provider) || modelProvider,
    model,
    reasoningEffort,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    recordCount,
    visibleUserCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    codexCompactionCount,
    estimatedTokens: authoritativeTokens ?? Math.ceil(estimatedCharacters / 4),
    warnings,
  };
}

/**
 * Quote a SQLite identifier discovered through PRAGMA table_xinfo.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}

/**
 * Read the threads table with dynamic capability detection and mandatory authority columns.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readAuthoritativeThreadRows(
  databasePath: string,
  threadId?: string,
): { rows: SqliteRow[]; columns: Set<string> } {
  if (!existsSync(databasePath)) {
    throw new CodexImportError("THREADS_DATABASE_NOT_FOUND", "Codex threads database was not found");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const capabilityRows = database.prepare("PRAGMA table_xinfo(threads)").all() as SqliteRow[];
    const columns = new Set(capabilityRows.map((row) => asString(row.name)).filter(Boolean));
    for (const required of ["id", "rollout_path"]) {
      if (!columns.has(required)) {
        throw new CodexImportError("THREADS_CAPABILITY_MISSING", `Codex threads table is missing ${required}`);
      }
    }
    const selected = [...columns]
      .filter((column) => THREAD_METADATA_COLUMNS.has(column))
      .map(quoteSqliteIdentifier)
      .join(", ");
    const statement = threadId === undefined
      ? database.prepare(`SELECT ${selected} FROM threads`)
      : database.prepare(`SELECT ${selected} FROM threads WHERE "id" = ?`);
    const rows = (threadId === undefined ? statement.all() : statement.all(threadId)) as SqliteRow[];
    return { rows, columns };
  } finally {
    database.close();
  }
}

/**
 * Read session_index.jsonl solely as a title fallback for ids already authorized by SQLite.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readSessionIndexTitles(codexHome: string, allowedIds: Set<string>): Map<string, string> {
  const titles = new Map<string, string>();
  const indexPath = join(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) return titles;
  assertNoLinkedPathComponents(indexPath);
  const indexStats = statSync(indexPath);
  if (!indexStats.isFile() || indexStats.size > 64 * 1024 * 1024) return titles;
  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const id = asString(record.id) || asString(record.thread_id);
      if (!allowedIds.has(id)) continue;
      const title = asString(record.thread_name) || asString(record.title) || asString(record.name);
      if (title) titles.set(id, title);
    } catch {
      // This append-only file is an incomplete title fallback, never the authority index.
    }
  }
  return titles;
}

/**
 * Convert common SQLite second or millisecond timestamps to ISO text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function sqliteTimestamp(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

/**
 * Select the first available dynamic SQLite column value.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function dynamicValue(row: SqliteRow, columns: Set<string>, names: string[]): unknown {
  for (const name of names) {
    if (columns.has(name) && row[name] !== null && row[name] !== undefined && row[name] !== "") return row[name];
  }
  return undefined;
}

/**
 * Prove that a rollout is an existing regular unlinked file under one of the two Codex session roots.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertCodexRolloutPath(sourcePath: string, codexHome: string): { path: string; archived: boolean } {
  if (!isAbsolute(sourcePath)) {
    throw new CodexImportError("SOURCE_PATH_REJECTED", "Codex rollout path must be absolute");
  }
  const candidate = resolve(sourcePath);
  const roots = [
    { path: resolve(codexHome, "sessions"), archived: false },
    { path: resolve(codexHome, "archived_sessions"), archived: true },
  ];
  const allowed = roots.find((root) => isPathWithin(candidate, root.path));
  if (!allowed) {
    throw new CodexImportError("SOURCE_PATH_REJECTED", "Codex rollout is outside the allowed session roots");
  }
  const realPath = assertExistingPathWithin(candidate, allowed.path, "SOURCE_PATH_REJECTED");
  const stats = statSync(realPath);
  if (!stats.isFile()) throw new CodexImportError("SOURCE_FILE_REJECTED", "Codex rollout must be a regular file");
  return { path: realPath, archived: allowed.archived };
}

/**
 * Compare stable file identity fields before and after a fixed-length read.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function sameFileState(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Hash a fixed source length through one descriptor and reject concurrent replacement or edits.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readStableSourceVersion(filePath: string): { hash: string; size: number; mtimeMs: number; sourceVersion: string } {
  const { fd } = openRegularFileNoFollow(filePath);
  try {
    const before = fstatSync(fd);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_SIZE);
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new CodexImportError("SOURCE_CHANGED", "Codex rollout changed while it was being read");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fstatSync(fd);
    assertNoLinkedPathComponents(filePath);
    const pathAfter = lstatSync(filePath);
    if (!sameFileState(before, after)
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size
      || pathAfter.mtimeMs !== after.mtimeMs) {
      throw new CodexImportError("SOURCE_CHANGED", "Codex rollout changed while it was being read");
    }
    const digest = hash.digest("hex");
    return {
      hash: digest,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sourceVersion: `${after.size}:${after.mtimeMs}:${digest}`,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Match a path filter using stable local path equality.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function matchesPathFilter(values: string[], filter: string | undefined): boolean {
  if (!filter) return true;
  const normalizeSearch = (value: string): string => value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .toLocaleLowerCase();
  const expected = normalizeSearch(filter);
  return values.some((value) => normalizeSearch(value).includes(expected));
}

/**
 * Resolve one SQLite authority row into safe list metadata without returning transcript bodies.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function buildCandidate(
  row: SqliteRow,
  columns: Set<string>,
  codexHome: string,
  agentDir: string,
  sessionTitles: Map<string, string>,
): Promise<CodexCandidate> {
  const id = asString(row.id);
  const rollout = assertCodexRolloutPath(asString(row.rollout_path), codexHome);
  const sqliteSource = dynamicValue(row, columns, ["source"]);
  const sqliteThreadSource = dynamicValue(row, columns, ["thread_source"]);
  const agentRole = dynamicValue(row, columns, ["agent_role"]);
  const inspection = await inspectCodexRollout({
    threadId: id,
    rolloutPath: rollout.path,
    sqliteSource,
    sqliteThreadSource,
    sqliteAgentRole: agentRole,
    modelProvider: asString(dynamicValue(row, columns, ["model_provider"])),
    model: asString(dynamicValue(row, columns, ["model"])),
    reasoningEffort: asString(dynamicValue(row, columns, ["reasoning_effort"])),
  });
  const identity = readStableSourceVersion(rollout.path);
  const importState = await getCodexImportState(agentDir, id, identity.sourceVersion);
  const archivedValue = dynamicValue(row, columns, ["archived"]);
  const archived = archivedValue === undefined ? rollout.archived : Boolean(Number(archivedValue));
  const initialCwd = inspection.initialCwd || asPathString(dynamicValue(row, columns, ["cwd"]));
  const effectiveCwd = inspection.effectiveCwd || initialCwd;
  const workspaceRoots = inspection.workspaceRoots.length > 0
    ? inspection.workspaceRoots
    : initialCwd ? [initialCwd] : [];
  const sqliteSandboxRoots = readSandboxPolicyRoots(dynamicValue(row, columns, ["sandbox_policy"]));
  const sandboxWritableRoots = inspection.sandboxWritableRoots.length > 0
    ? inspection.sandboxWritableRoots
    : sqliteSandboxRoots;
  const name = (asString(dynamicValue(row, columns, ["name", "title"])) || sessionTitles.get(id) || id).slice(0, 4_096);
  const warnings = [...inspection.warnings];
  let cwdExists = false;
  if (effectiveCwd) {
    try {
      assertNoLinkedPathComponents(effectiveCwd);
      cwdExists = statSync(effectiveCwd).isDirectory();
    } catch {
      cwdExists = false;
    }
  }
  if (!cwdExists) addWarning(warnings, "CWD_REMAP_REQUIRED", "The source cwd is unavailable and must be remapped");

  return {
    id,
    name,
    rolloutPath: rollout.path,
    initialCwd,
    effectiveCwd,
    workspaceRoots,
    sandboxWritableRoots,
    cwdExists,
    archived,
    archivedAt: Number(dynamicValue(row, columns, ["archived_at"])) || undefined,
    createdAt: sqliteTimestamp(dynamicValue(row, columns, ["created_at_ms", "created_at"])) ?? inspection.createdAt,
    updatedAt: sqliteTimestamp(dynamicValue(row, columns, ["updated_at_ms", "updated_at", "recency_at_ms", "recency_at"])),
    sourceKind: inspection.sourceKind,
    sqliteSource,
    sqliteThreadSource,
    agentRole,
    modelProvider: inspection.modelProvider || undefined,
    model: inspection.model || undefined,
    reasoningEffort: inspection.reasoningEffort || undefined,
    cliVersion: asString(dynamicValue(row, columns, ["cli_version"])) || undefined,
    sourceVersion: identity.sourceVersion,
    recordCount: inspection.recordCount,
    visibleUserCount: inspection.visibleUserCount,
    assistantCount: inspection.assistantCount,
    toolCallCount: inspection.toolCallCount,
    toolResultCount: inspection.toolResultCount,
    codexCompactionCount: inspection.codexCompactionCount,
    estimatedTokens: inspection.estimatedTokens,
    importState: importState.status,
    importedSessionId: importState.sessionId,
    warnings,
    riskCodes: warnings.map((warning) => warning.code),
  };
}

/**
 * Apply user-visible filters while keeping archive, subagent, and guardian records hidden by default.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function candidateMatchesFilters(candidate: CodexCandidate, filters: CodexCandidateFilters): boolean {
  if (!filters.includeArchived && candidate.archived) return false;
  if (!filters.includeSubagents && candidate.sourceKind === "subagent") return false;
  if (!filters.includeGuardians && candidate.sourceKind === "guardian") return false;
  if (filters.name && !candidate.name.toLocaleLowerCase().includes(filters.name.toLocaleLowerCase())) return false;
  if (!matchesPathFilter(candidate.workspaceRoots, filters.workspace)) return false;
  if (!matchesPathFilter(candidate.sandboxWritableRoots, filters.sandbox)) return false;
  if (!matchesPathFilter([candidate.effectiveCwd], filters.cwd)) return false;
  return true;
}

/**
 * Resolve exactly one SQLite-authorized thread without opening unrelated rollouts.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function getCodexCandidateById(options: {
  codexHome: string;
  agentDir: string;
  threadId: string;
}): Promise<CodexCandidate> {
  const databasePath = join(options.codexHome, "state_5.sqlite");
  const { rows, columns } = readAuthoritativeThreadRows(databasePath, options.threadId);
  const validRows = rows.filter((row) => (
    asString(row.id) === options.threadId && Boolean(asString(row.rollout_path))
  ));
  if (validRows.length === 0) {
    throw new CodexImportError("CODEX_SESSION_NOT_FOUND", "Selected Codex session was not found");
  }
  const distinctPaths = new Set(validRows.map((row) => normalizePathForComparison(asString(row.rollout_path))));
  if (distinctPaths.size !== 1) {
    throw new CodexImportError("AMBIGUOUS_THREAD_ROW", "Selected Codex thread has conflicting rollout paths");
  }
  const sessionTitles = readSessionIndexTitles(options.codexHome, new Set([options.threadId]));
  return buildCandidate(validRows[0], columns, options.codexHome, options.agentDir, sessionTitles);
}

/**
 * Enumerate only SQLite-authorized Codex threads, deduplicated by id and rollout path.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function listCodexCandidates(options: ListCodexCandidatesOptions): Promise<CodexCandidate[]> {
  const databasePath = join(options.codexHome, "state_5.sqlite");
  const { rows, columns } = readAuthoritativeThreadRows(databasePath);
  const authoritativeIds = new Set(rows.map((row) => asString(row.id)).filter(Boolean));
  const needsTitleFallback = rows.some((row) => !asString(dynamicValue(row, columns, ["name", "title"])));
  const sessionTitles = needsTitleFallback
    ? readSessionIndexTitles(options.codexHome, authoritativeIds)
    : new Map<string, string>();
  const filters = options.filters ?? {};
  const requestedLimit = Number(filters.limit);
  const boundedLimit = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : undefined;
  const seen = new Set<string>();
  const candidates: CodexCandidate[] = [];
  const orderedRows = [...rows].sort((left, right) => (
    Number(dynamicValue(right, columns, ["updated_at_ms", "updated_at", "recency_at_ms", "recency_at"]))
    - Number(dynamicValue(left, columns, ["updated_at_ms", "updated_at", "recency_at_ms", "recency_at"]))
  ));

  for (const row of orderedRows) {
    const id = asString(row.id);
    const rolloutPath = asString(row.rollout_path);
    if (!id || !rolloutPath) continue;
    const key = `${id}\0${normalizePathForComparison(rolloutPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rowArchived = Boolean(Number(dynamicValue(row, columns, ["archived"])))
      || isPathWithin(resolve(rolloutPath), resolve(options.codexHome, "archived_sessions"));
    if (!filters.includeArchived && rowArchived) continue;
    const rowKind = classifyCodexThreadSource({
      source: dynamicValue(row, columns, ["source"]),
      threadSource: dynamicValue(row, columns, ["thread_source"]),
      agentRole: dynamicValue(row, columns, ["agent_role"]),
    });
    if ((!filters.includeSubagents && rowKind === "subagent")
      || (!filters.includeGuardians && rowKind === "guardian")) continue;
    const rowName = asString(dynamicValue(row, columns, ["name", "title"])) || sessionTitles.get(id) || id;
    if (filters.name && !rowName.toLocaleLowerCase().includes(filters.name.toLocaleLowerCase())) continue;
    try {
      const candidate = await buildCandidate(row, columns, options.codexHome, options.agentDir, sessionTitles);
      if (candidateMatchesFilters(candidate, filters)) candidates.push(candidate);
    } catch {
      // One damaged or concurrently changing rollout must not block unrelated candidates.
    }
    if (boundedLimit !== undefined && candidates.length >= boundedLimit) break;
  }

  candidates.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt ?? "");
    const rightTime = Date.parse(right.updatedAt ?? "");
    const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
    const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
    return normalizedRight === normalizedLeft
      ? left.id.localeCompare(right.id)
      : normalizedRight - normalizedLeft;
  });
  if (boundedLimit === undefined) return candidates;
  return candidates.slice(0, boundedLimit);
}

/**
 * Require an explicit valid directory remap whenever the recorded cwd is unavailable.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function resolveCodexImportCwd(sourceCwd: string, explicitRemap?: string): string {
  const selected = explicitRemap || sourceCwd;
  let valid = false;
  if (selected && isAbsolute(selected)) {
    try {
      assertNoLinkedPathComponents(selected);
      valid = statSync(selected).isDirectory();
    } catch {
      valid = false;
    }
  }
  if (!valid || (!explicitRemap && selected !== sourceCwd)) {
    throw new CodexImportError("CWD_REMAP_REQUIRED", "An explicit existing cwd remap is required");
  }
  if (!explicitRemap && (!sourceCwd || !existsSync(sourceCwd))) {
    throw new CodexImportError("CWD_REMAP_REQUIRED", "An explicit existing cwd remap is required");
  }
  return resolve(selected);
}

/**
 * Validate the fixed snapshot/owner naming relationship before verification or cleanup.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertSnapshotShape(snapshot: CodexRolloutSnapshot): void {
  if (!isAbsolute(snapshot.path)
    || !isAbsolute(snapshot.ownerPath)
    || !snapshot.ownerToken
    || snapshot.ownerPath !== `${snapshot.path}.owner`
    || basename(dirname(snapshot.path)) !== "snapshots"
    || basename(dirname(dirname(snapshot.path))) !== "codex"
    || basename(dirname(dirname(dirname(snapshot.path)))) !== "imports") {
    throw new CodexImportError("SNAPSHOT_PATH_REJECTED", "Snapshot path is outside the fixed import layout");
  }
  assertNoLinkedPathComponents(snapshot.path);
  assertNoLinkedPathComponents(snapshot.ownerPath);
}

/**
 * Read and compare the unlinked owner token that protects a snapshot cleanup capability.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertSnapshotOwnership(snapshot: CodexRolloutSnapshot): void {
  assertSnapshotShape(snapshot);
  const owner = openRegularFileNoFollow(snapshot.ownerPath);
  try {
    if (owner.stats.size > 1024) throw new CodexImportError("SNAPSHOT_OWNER_MISMATCH", "Snapshot owner token is invalid");
    const value = readFileSync(owner.fd, "utf8");
    if (value !== snapshot.ownerToken) {
      throw new CodexImportError("SNAPSHOT_OWNER_MISMATCH", "Snapshot owner token does not match");
    }
  } finally {
    closeSync(owner.fd);
  }
}

/**
 * Copy exactly the initial source length through one descriptor and compare file identity around the copy.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function copyFixedSource(
  sourcePath: string,
  snapshotPath: string,
  onSourceChunk?: (chunk: Uint8Array) => void,
): { hash: string; size: number; mtimeMs: number; sourceVersion: string } {
  const source = openRegularFileNoFollow(sourcePath);
  const outputFd = openSync(snapshotPath, "wx", 0o600);
  try {
    const before = fstatSync(source.fd);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_SIZE);
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = readSync(source.fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new CodexImportError("SOURCE_CHANGED", "Codex rollout changed during snapshot creation");
      const chunk = buffer.subarray(0, bytesRead);
      let written = 0;
      while (written < bytesRead) written += writeSync(outputFd, chunk, written, bytesRead - written);
      hash.update(chunk);
      offset += bytesRead;
      onSourceChunk?.(chunk);
    }
    fsyncSync(outputFd);
    const after = fstatSync(source.fd);
    assertNoLinkedPathComponents(sourcePath);
    const pathAfter = lstatSync(sourcePath);
    if (!sameFileState(before, after)
      || pathAfter.isSymbolicLink()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size
      || pathAfter.mtimeMs !== after.mtimeMs) {
      throw new CodexImportError("SOURCE_CHANGED", "Codex rollout changed during snapshot creation");
    }
    const digest = hash.digest("hex");
    return {
      hash: digest,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sourceVersion: `${after.size}:${after.mtimeMs}:${digest}`,
    };
  } finally {
    closeSync(outputFd);
    closeSync(source.fd);
  }
}

/**
 * Remove an incomplete unique snapshot path that has not yet received an owner token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function removeIncompleteSnapshot(snapshotPath: string): void {
  try {
    if (existsSync(snapshotPath)) unlinkSync(snapshotPath);
  } catch {
    // The caller will report the source/snapshot failure; incomplete unique files are never published.
  }
}

/**
 * Persist and flush an exclusive snapshot owner token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function writeSnapshotOwner(ownerPath: string, ownerToken: string): void {
  const fd = openSync(ownerPath, "wx", 0o600);
  try {
    writeFileSync(fd, ownerToken, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a stable fixed-length snapshot in agentDir/imports/codex/snapshots with an owner capability.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function createStableRolloutSnapshot(options: CreateRolloutSnapshotOptions): Promise<CodexRolloutSnapshot> {
  const source = assertCodexRolloutPath(options.sourcePath, options.codexHome);
  const snapshotRoot = ensureSecureDirectory(
    resolve(options.agentDir),
    resolve(options.agentDir, "imports", "codex", "snapshots"),
  );
  const attempts = Math.max(1, Math.min(10, Math.floor(options.maxAttempts ?? 3)));
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ownerToken = randomUUID();
    const threadPrefix = createHash("sha256").update(options.threadId).digest("hex").slice(0, 16);
    const snapshotPath = join(snapshotRoot, `${threadPrefix}-${ownerToken}.jsonl`);
    const ownerPath = `${snapshotPath}.owner`;
    try {
      const copied = copyFixedSource(source.path, snapshotPath, options.onSourceChunk);
      writeSnapshotOwner(ownerPath, ownerToken);
      const snapshot: CodexRolloutSnapshot = {
        path: snapshotPath,
        ownerPath,
        ownerToken,
        hash: copied.hash,
        size: copied.size,
        sourceMtimeMs: copied.mtimeMs,
        sourceVersion: copied.sourceVersion,
      };
      for await (const record of readStrictCodexJsonl(snapshot.path, snapshot)) {
        void record;
      }
      await verifyRolloutSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      lastError = error;
      if (existsSync(ownerPath)) {
        try {
          cleanupRolloutSnapshot({
            path: snapshotPath,
            ownerPath,
            ownerToken,
            hash: "",
            size: 0,
            sourceMtimeMs: 0,
            sourceVersion: "",
          });
        } catch {
          removeIncompleteSnapshot(snapshotPath);
          removeIncompleteSnapshot(ownerPath);
        }
      } else {
        removeIncompleteSnapshot(snapshotPath);
      }
      if (!(error instanceof CodexImportError) || error.code !== "SOURCE_CHANGED") throw error;
    }
  }
  if (lastError instanceof CodexImportError) throw lastError;
  throw new CodexImportError("SOURCE_CHANGED", "Codex rollout did not remain stable during snapshot creation");
}

/**
 * Recheck owner capability, length, hash, and before/after descriptor state after conversion.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function verifyRolloutSnapshot(snapshot: CodexRolloutSnapshot): Promise<void> {
  try {
    assertSnapshotOwnership(snapshot);
    for await (const record of readStrictCodexJsonl(snapshot.path, snapshot)) {
      void record;
    }
    const opened = openRegularFileNoFollow(snapshot.path);
    try {
      const before = fstatSync(opened.fd);
      if (before.size !== snapshot.size) throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot length changed");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_SIZE);
      let offset = 0;
      while (offset < snapshot.size) {
        const bytesRead = readSync(opened.fd, buffer, 0, Math.min(buffer.length, snapshot.size - offset), offset);
        if (bytesRead === 0) throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot was truncated");
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = fstatSync(opened.fd);
      if (!sameFileState(before, after) || hash.digest("hex") !== snapshot.hash) {
        throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot content changed");
      }
    } finally {
      closeSync(opened.fd);
    }
  } catch (error) {
    if (error instanceof CodexImportError && error.code === "SNAPSHOT_CHANGED") throw error;
    throw new CodexImportError("SNAPSHOT_CHANGED", "Snapshot could not be verified", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Safely remove only the snapshot still protected by the caller's owner token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function cleanupRolloutSnapshot(snapshot: CodexRolloutSnapshot): void {
  assertSnapshotOwnership(snapshot);
  const opened = openRegularFileNoFollow(snapshot.path);
  closeSync(opened.fd);
  unlinkSync(snapshot.path);
  unlinkSync(snapshot.ownerPath);
}

/**
 * Compatibility name for callers that release a verified rollout snapshot.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function removeRolloutSnapshot(snapshot: CodexRolloutSnapshot): void {
  cleanupRolloutSnapshot(snapshot);
}
