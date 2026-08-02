import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import lockfile from "proper-lockfile";
import { CodexImportError } from "./errors";
import {
  assertExistingPathWithin,
  assertNoLinkedPathComponents,
  ensureSecureDirectory,
  isPathWithin,
  normalizePathForComparison,
  openRegularFileNoFollow,
} from "./filesystem";
import type { ConvertedPiSession, ImportedCodexState } from "./types";

const IMPORT_MARKER = "codex-import";
const EARLY_MARKER_LINES = 32;
const EARLY_MARKER_BYTES = 256 * 1024;

interface AgentDirOptions {
  testMode?: boolean;
  /** Ignored deliberately; production is always derived locally. */
  productionAgentDir?: string;
}

interface CodexImportPaths {
  root: string;
  locks: string;
  staging: string;
  snapshots: string;
  checkpoints: string;
}

interface LockOptions {
  agentDir: string;
  threadId: string;
  staleMs?: number;
  retries?: number;
}

interface PublishOptions {
  agentDir: string;
  conversion: ConvertedPiSession;
  signal?: AbortSignal;
}

interface PublishTestHooks {
  beforePublish?: () => void | Promise<void>;
  forcedFileName?: string;
}

interface PublishedPiSession {
  sessionId: string;
  cwd: string;
  fileName: string;
  filePath: string;
}

interface PublishedPiSessionValidation {
  sessionId: string;
  cwd: string;
  contextMessageCount: number;
  toolCallCount: number;
  toolResultCount: number;
}

interface ImportMarker {
  threadId: string;
  sourceVersion: string;
}

interface StagingProof {
  hash: string;
  size: number;
  dev: number;
  ino: number;
}

const REPLAY_MODEL: Model<"openai-codex-responses"> = {
  id: "codex-import-validation",
  name: "Codex import validation",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_000,
};

/**
 * Validate the fixed agent directory and all existing import path components.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertCodexImportAgentDir(agentDir: string, options: AgentDirOptions = {}): string {
  if (!agentDir || !isAbsolute(agentDir) || agentDir.split(/[\\/]+/).includes("..")) {
    throw new CodexImportError("AGENT_DIR_REJECTED", "Codex import requires a fixed absolute agent directory");
  }
  assertNoLinkedPathComponents(agentDir);
  if (!existsSync(agentDir) || !lstatSync(agentDir).isDirectory()) {
    throw new CodexImportError("AGENT_DIR_REJECTED", "Pi agent directory does not exist or is not a directory");
  }
  const realAgentDir = realpathSync.native(agentDir);
  const productionAgentDir = join(homedir(), ".pi", "agent");
  const canonicalProductionDir = existsSync(productionAgentDir)
    ? realpathSync.native(productionAgentDir)
    : resolve(productionAgentDir);
  if (options.testMode === true) {
    let reachesProductionIdentity = false;
    if (existsSync(canonicalProductionDir)) {
      const productionStats = statSync(canonicalProductionDir);
      let ancestor = realAgentDir;
      while (true) {
        const ancestorStats = statSync(ancestor);
        if (productionStats.ino !== 0
          && ancestorStats.dev === productionStats.dev && ancestorStats.ino === productionStats.ino) {
          reachesProductionIdentity = true;
          break;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    if (reachesProductionIdentity || isPathWithin(realAgentDir, canonicalProductionDir)) {
      throw new CodexImportError("PRODUCTION_AGENT_DIR_REJECTED", "Tests cannot use the production Pi agent directory or its descendants");
    }
  }
  const paths = buildCodexImportPaths(realAgentDir);
  for (const path of [join(realAgentDir, "imports"), paths.root, paths.locks, paths.staging, paths.snapshots, paths.checkpoints]) {
    assertNoLinkedPathComponents(path);
    if (existsSync(path) && !lstatSync(path).isDirectory()) {
      throw new CodexImportError("IMPORT_PATH_REJECTED", "Codex import infrastructure must contain only directories");
    }
  }
  return realAgentDir;
}

/**
 * Return fixed import infrastructure paths without creating them.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function getCodexImportPaths(agentDir: string): CodexImportPaths {
  return buildCodexImportPaths(assertCodexImportAgentDir(agentDir));
}

/**
 * Build paths rooted below agentDir/imports/codex.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function buildCodexImportPaths(agentDir: string): CodexImportPaths {
  const root = join(agentDir, "imports", "codex");
  return {
    root,
    locks: join(root, "locks"),
    staging: join(root, "staging"),
    snapshots: join(root, "snapshots"),
    checkpoints: join(root, "checkpoints"),
  };
}

/**
 * Securely create every import infrastructure directory.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function ensureCodexImportPaths(agentDir: string): CodexImportPaths {
  const realAgentDir = assertCodexImportAgentDir(agentDir);
  const paths = buildCodexImportPaths(realAgentDir);
  ensureSecureDirectory(realAgentDir, paths.root);
  for (const path of [paths.locks, paths.staging, paths.snapshots, paths.checkpoints]) {
    ensureSecureDirectory(realAgentDir, path);
  }
  return paths;
}

/**
 * Reject identifiers that could select another thread's filesystem objects.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertSafeThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/.test(threadId)) {
    throw new CodexImportError("THREAD_ID_REJECTED", "Codex thread id is not safe for local storage");
  }
}

/**
 * Run one operation under a recoverable, cross-process lock dedicated to a thread.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function withCodexImportLock<T>(options: LockOptions, operation: () => T | Promise<T>): Promise<T> {
  assertSafeThreadId(options.threadId);
  const paths = ensureCodexImportPaths(options.agentDir);
  const target = join(paths.locks, `${options.threadId}.target`);
  if (!existsSync(target)) {
    try {
      closeSync(openSync(target, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  assertExistingPathWithin(target, paths.locks, "LOCK_PATH_REJECTED");
  assertNoLinkedPathComponents(`${target}.lock`);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(target, {
      stale: Math.max(1, options.staleMs ?? 30_000),
      retries: Math.max(0, options.retries ?? 0),
      realpath: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
      throw new CodexImportError("IMPORT_LOCKED", "This Codex thread is already being imported");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    try {
      await release();
    } catch {
      // The stale timeout safely recovers the lock; release failure must not mask a committed import.
    }
  }
}

/**
 * Serialize a conversion with a bounded, early provenance marker.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function serializeForPublication(conversion: ConvertedPiSession): Buffer {
  const earlyEntries = conversion.entries.slice(0, EARLY_MARKER_LINES);
  const hasMarker = earlyEntries.some((entry) => isCodexImportMarkerRecord(entry as unknown as Record<string, unknown>));
  if (!hasMarker) {
    throw new CodexImportError("MISSING_IMPORT_METADATA", "Converted Pi session lacks its early import marker");
  }
  try {
    return Buffer.from(`${[conversion.header, ...conversion.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  } catch (error) {
    throw new CodexImportError("SESSION_SERIALIZE_FAILED", "Converted Pi session cannot be serialized", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Create a job directory and persist its unguessable ownership token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function createOwnedStagingJob(stagingRoot: string): { jobRoot: string; ownerPath: string; ownerToken: string } {
  const ownerToken = randomUUID();
  const jobRoot = join(stagingRoot, `job-${ownerToken}`);
  ensureSecureDirectory(stagingRoot, jobRoot);
  const ownerPath = join(jobRoot, "owner");
  const fd = openSync(ownerPath, "wx", 0o600);
  try {
    writeFileSync(fd, ownerToken, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { jobRoot, ownerPath, ownerToken };
}

/**
 * Prove that a staging job still belongs to the caller.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertJobOwner(jobRoot: string, ownerPath: string, ownerToken: string): void {
  assertExistingPathWithin(jobRoot, resolve(jobRoot, ".."), "STAGING_PATH_REJECTED");
  const opened = openRegularFileNoFollow(ownerPath);
  try {
    const actual = readFileSync(opened.fd, "utf8");
    if (actual !== ownerToken) {
      throw new CodexImportError("STAGING_OWNER_CHANGED", "Staging ownership changed before publication");
    }
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Remove only a staging job whose owner token still matches.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function cleanupOwnedStagingJob(jobRoot: string, ownerPath: string, ownerToken: string): void {
  try {
    assertJobOwner(jobRoot, ownerPath, ownerToken);
  } catch {
    return;
  }
  try {
    assertNoLinkedPathComponents(jobRoot);
    rmSync(jobRoot, { recursive: true, force: true });
  } catch {
    // Owned staging is non-enumerable; cleanup failure must not mask an atomic publication result.
  }
}

/**
 * Write and independently verify one exclusive, durable staging JSONL file.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function writeVerifiedStagingFile(filePath: string, stagingRoot: string, content: Buffer): StagingProof {
  const writeFd = openSync(filePath, "wx", 0o600);
  let proof: StagingProof;
  try {
    let written = 0;
    while (written < content.length) {
      written += writeSync(writeFd, content, written, content.length - written, written);
    }
    fsyncSync(writeFd);
    const stats = fstatSync(writeFd);
    if (!stats.isFile() || stats.size !== content.length) {
      throw new CodexImportError("STAGING_WRITE_MISMATCH", "Staging JSONL size changed while it was written");
    }
    proof = {
      hash: createHash("sha256").update(content).digest("hex"),
      size: stats.size,
      dev: stats.dev,
      ino: stats.ino,
    };
  } finally {
    closeSync(writeFd);
  }
  verifyStagingFile(filePath, stagingRoot, proof);
  return proof;
}

/**
 * Recheck a staged inode, size, hash, and real path without following links.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function verifyStagingFile(filePath: string, stagingRoot: string, proof: StagingProof): void {
  const opened = openRegularFileNoFollow(filePath);
  try {
    const actualHash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.stats.size) {
      const bytesRead = readSync(opened.fd, chunk, 0, Math.min(chunk.length, opened.stats.size - offset), offset);
      if (bytesRead === 0) break;
      actualHash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fstatSync(opened.fd);
    const realFile = realpathSync.native(filePath);
    const realStaging = realpathSync.native(stagingRoot);
    if (
      proof.dev !== after.dev || proof.ino !== after.ino || proof.size !== after.size ||
      offset !== after.size || actualHash.digest("hex") !== proof.hash || !isPathWithin(realFile, realStaging)
    ) {
      throw new CodexImportError("STAGING_WRITE_MISMATCH", "Staging JSONL failed its hash or path verification");
    }
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Derive the SDK-compatible session directory and secure it below agentDir.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function getSecureSessionDir(cwd: string, agentDir: string): string {
  if (!cwd || !isAbsolute(cwd)) {
    throw new CodexImportError("SESSION_CWD_REJECTED", "Imported session cwd must be absolute");
  }
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionsRoot = join(agentDir, "sessions");
  ensureSecureDirectory(agentDir, sessionsRoot);
  return ensureSecureDirectory(agentDir, join(sessionsRoot, safePath));
}

/**
 * Validate tool-call ordering and exercise OpenAI Responses replay conversion.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validateReplay(messages: AgentMessage[]): { toolCallCount: number; toolResultCount: number } {
  const replayMessages = convertToLlm(messages);
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  for (const message of replayMessages) {
    if ((message.role === "user" || message.role === "assistant") && pending.size > 0) {
      throw new CodexImportError("UNPAIRED_TOOL_CALL", "A conversation message appears before pending tool calls finish");
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(block.id) || pending.has(block.id) || completed.has(block.id)) {
          throw new CodexImportError("DUPLICATE_TOOL_CALL", "Imported tool-call ids must be unique and portable");
        }
        if (!block.name || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) {
          throw new CodexImportError("INVALID_TOOL_CALL", "Imported tool call is malformed");
        }
        pending.set(block.id, block.name);
        toolCallCount++;
      }
    } else if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) {
        throw new CodexImportError("ORPHAN_TOOL_RESULT", "Imported tool result does not match a preceding tool call");
      }
      pending.delete(message.toolCallId);
      completed.add(message.toolCallId);
      toolResultCount++;
    }
  }
  if (pending.size > 0) {
    throw new CodexImportError("UNPAIRED_TOOL_CALL", "Imported history ends with pending tool calls");
  }
  let replay: unknown[];
  try {
    replay = convertResponsesMessages(
      REPLAY_MODEL,
      { systemPrompt: "", messages: replayMessages, tools: [] },
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    ) as unknown[];
  } catch {
    throw new CodexImportError("RESPONSES_REPLAY_FAILED", "Responses replay rejected the imported history");
  }
  validateReplayItems(replay, toolCallCount, toolResultCount);
  return { toolCallCount, toolResultCount };
}

/**
 * Verify that Responses conversion preserves every call/result pair and its order.
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
    const item = value as Record<string, unknown>;
    if ((item.role === "user" || (item.type === "message" && item.role === "assistant")) && open.size > 0) {
      throw new CodexImportError("INVALID_REPLAY_ORDER", "Responses replay interrupts pending tool calls");
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!callId || calls.has(callId)) {
        throw new CodexImportError("INVALID_REPLAY_CALL", "Responses replay produced an invalid tool call");
      }
      calls.add(callId);
      open.add(callId);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      if (!open.delete(callId) || results.has(callId)) {
        throw new CodexImportError("INVALID_REPLAY_RESULT", "Responses replay produced an invalid tool result");
      }
      results.add(callId);
    }
  }
  if (open.size > 0 || calls.size !== expectedCalls || results.size !== expectedResults) {
    throw new CodexImportError("INCOMPLETE_RESPONSES_REPLAY", "Responses replay did not preserve every tool pair");
  }
}

/**
 * Open a JSONL through SessionManager and validate its portable replay context.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function validatePublishedPiSession(
  filePath: string,
  expectedCwd: string,
): Promise<PublishedPiSessionValidation> {
  assertNoLinkedPathComponents(filePath);
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new CodexImportError("SESSION_FILE_REJECTED", "Published Pi session is not a regular file");
  }
  const manager = SessionManager.open(filePath);
  const header = manager.getHeader();
  const entries: SessionEntry[] = manager.getEntries();
  const context = manager.buildSessionContext();
  if (!header || header.version !== 3 || !header.id || entries.length === 0) {
    throw new CodexImportError("INVALID_PI_SESSION", "Published file is not a non-empty Pi v3 session");
  }
  if (normalizePathForComparison(manager.getCwd()) !== normalizePathForComparison(expectedCwd)) {
    throw new CodexImportError("SESSION_CWD_MISMATCH", "Published Pi session cwd does not match its target");
  }
  if (context.messages.length === 0) {
    throw new CodexImportError("EMPTY_PI_CONTEXT", "Published Pi session has no replayable messages");
  }
  const replay = validateReplay(context.messages);
  return {
    sessionId: manager.getSessionId(),
    cwd: manager.getCwd(),
    contextMessageCount: context.messages.length,
    ...replay,
  };
}

/**
 * Flush the published directory where the platform supports directory fsync.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function syncPublishedDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Publish a validated staging file atomically without exposing test-only hooks in the TypeScript API.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function publishConvertedPiSession(options: PublishOptions): Promise<PublishedPiSession>;
export async function publishConvertedPiSession(options: PublishOptions): Promise<PublishedPiSession> {
  const hooks = options as PublishOptions & PublishTestHooks;
  const realAgentDir = assertCodexImportAgentDir(options.agentDir);
  const paths = ensureCodexImportPaths(realAgentDir);
  const targetDir = getSecureSessionDir(options.conversion.header.cwd, realAgentDir);
  const forcedFileName = hooks.forcedFileName;
  const generatedName = `${options.conversion.header.timestamp.replace(/[:.]/g, "-")}_${options.conversion.header.id}.jsonl`;
  const fileName = forcedFileName ?? generatedName;
  if (basename(fileName) !== fileName || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(fileName)) {
    throw new CodexImportError("SESSION_FILE_NAME_REJECTED", "Published session filename is not safe");
  }
  const targetPath = join(targetDir, fileName);
  const owner = createOwnedStagingJob(paths.staging);
  const stagingPath = join(owner.jobRoot, "session.jsonl");
  try {
    const stagingProof = writeVerifiedStagingFile(
      stagingPath,
      paths.staging,
      serializeForPublication(options.conversion),
    );
    const validation = await validatePublishedPiSession(stagingPath, options.conversion.header.cwd);
    if (validation.sessionId !== options.conversion.header.id) {
      throw new CodexImportError("SESSION_ID_MISMATCH", "Staged Pi session id changed during validation");
    }
    await hooks.beforePublish?.();
    assertJobOwner(owner.jobRoot, owner.ownerPath, owner.ownerToken);
    verifyStagingFile(stagingPath, paths.staging, stagingProof);
    assertExistingPathWithin(targetDir, realAgentDir, "SESSION_PATH_REJECTED");
    assertNoLinkedPathComponents(targetPath);
    if (options.signal?.aborted) {
      throw new CodexImportError("IMPORT_CANCELLED", "Codex session import was cancelled before atomic publication");
    }
    try {
      linkSync(stagingPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CodexImportError("SESSION_ALREADY_EXISTS", "A Pi session already exists at the publication target");
      }
      throw error;
    }
    try {
      const staged = statSync(stagingPath);
      const published = lstatSync(targetPath);
      const realTarget = realpathSync.native(targetPath);
      if (!published.isFile() || staged.dev !== published.dev || staged.ino !== published.ino || !isPathWithin(realTarget, targetDir)) {
        throw new CodexImportError("ATOMIC_PUBLISH_FAILED", "Published Pi session failed its atomic link verification");
      }
      syncPublishedDirectory(targetDir);
    } catch (error) {
      try {
        const staged = statSync(stagingPath);
        const published = lstatSync(targetPath);
        if (staged.dev === published.dev && staged.ino === published.ino) unlinkSync(targetPath);
      } catch {
        // A path no longer proven to be ours must never be removed.
      }
      throw error;
    }
    try {
      unlinkSync(stagingPath);
    } catch {
      // The hard link is already a complete durable publication; cleanup remains best-effort.
    }
    return {
      sessionId: options.conversion.header.id,
      cwd: options.conversion.header.cwd,
      fileName,
      filePath: targetPath,
    };
  } finally {
    cleanupOwnedStagingJob(owner.jobRoot, owner.ownerPath, owner.ownerToken);
  }
}

/**
 * Recognize only explicit Codex import marker records.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function isCodexImportMarkerRecord(record: Record<string, unknown>): boolean {
  return record.type === "custom" && record.customType === IMPORT_MARKER;
}

/**
 * Read marker fields from supported provenance wrappers.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function parseImportMarker(record: Record<string, unknown>): ImportMarker | undefined {
  if (!isCodexImportMarkerRecord(record)) return undefined;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : undefined;
  const threadId = data?.sourceThreadId;
  const sourceVersion = data?.sourceVersion;
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)
    || typeof sourceVersion !== "string" || sourceVersion.length === 0 || sourceVersion.length > 512
    || /[\u0000-\u001f]/.test(sourceVersion)) return undefined;
  return { threadId, sourceVersion };
}

/**
 * Read only the bounded beginning of a session while looking for its marker.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function readEarlySessionMarker(filePath: string): { sessionId?: string; marker?: ImportMarker } {
  const opened = openRegularFileNoFollow(filePath);
  try {
    const length = Math.min(opened.stats.size, EARLY_MARKER_BYTES);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(opened.fd, buffer, 0, length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, EARLY_MARKER_LINES);
    let sessionId: string | undefined;
    let previousEntryId: string | null = null;
    let entryCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
      if (!sessionId) {
        if (record.type !== "session" || record.version !== 3 || typeof record.id !== "string") return {};
        sessionId = record.id;
        continue;
      }
      entryCount += 1;
      if (typeof record.id !== "string" || record.parentId !== previousEntryId) return {};
      if (entryCount === 1 && record.type !== "session_info") return {};
      previousEntryId = record.id;
      const marker = parseImportMarker(record);
      if (marker && entryCount === 2) return { sessionId, marker };
      if (entryCount >= 2) return { sessionId };
    }
    return { sessionId };
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Scan the two-level Pi sessions tree for an exact or changed import marker.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function getCodexImportState(
  agentDir: string,
  threadId: string,
  sourceVersion: string,
): Promise<ImportedCodexState> {
  assertSafeThreadId(threadId);
  if (!sourceVersion) throw new CodexImportError("SOURCE_VERSION_REJECTED", "Codex source version is required");
  const realAgentDir = assertCodexImportAgentDir(agentDir);
  const sessionsRoot = join(realAgentDir, "sessions");
  if (!existsSync(sessionsRoot)) return { status: "available" };
  assertExistingPathWithin(sessionsRoot, realAgentDir, "SESSIONS_PATH_REJECTED");
  let changed: ImportedCodexState | undefined;
  for (const directory of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const directoryPath = join(sessionsRoot, directory.name);
    if (lstatSync(directoryPath).isSymbolicLink()) continue;
    for (const file of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".jsonl")) continue;
      const filePath = join(directoryPath, file.name);
      let found: ReturnType<typeof readEarlySessionMarker>;
      try {
        found = readEarlySessionMarker(filePath);
      } catch {
        continue;
      }
      if (!found.marker || found.marker.threadId !== threadId) continue;
      const state: ImportedCodexState = {
        status: found.marker.sourceVersion === sourceVersion ? "already_imported" : "source_changed",
        sessionId: found.sessionId,
        filePath,
        sourceVersion: found.marker.sourceVersion,
      };
      if (state.status === "already_imported") return state;
      changed ??= state;
    }
  }
  return changed ?? { status: "available" };
}
