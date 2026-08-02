import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
  generateSummaryWithUsage,
  getAgentDir,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  CodexCompactionPlanInfo,
  CodexImportCandidateInfo,
  CodexImportPreflightRequest,
  CodexImportPreflightResponse,
  CodexImportRunResponse,
} from "../api-types";
import { allowFileRoot } from "../file-access";
import { invalidateSessionListCache } from "../session-reader";
import {
  applySemanticCompaction,
  createFileCompactionCheckpointStore,
  executeSemanticCompactionPlan,
  planSemanticCompaction,
  type SemanticSummaryInput,
} from "./compaction";
import { convertCodexRollout } from "./converter";
import { CodexImportError } from "./errors";
import {
  projectImportedCodexProviderHistory,
  readCodexImportRuntimePolicy,
  type CodexImportRuntimePolicy,
} from "./runtime";
import {
  cleanupRolloutSnapshot,
  createStableRolloutSnapshot,
  getCodexCandidateById,
  inspectCodexRollout,
  listCodexCandidates,
  resolveCodexImportCwd,
  verifyRolloutSnapshot,
} from "./source";
import {
  assertCodexImportAgentDir,
  getCodexImportState,
  publishConvertedPiSession,
  withCodexImportLock,
} from "./storage";
import type {
  CodexCandidate,
  CodexCandidateFilters,
  CodexRolloutInspection,
  CodexRolloutSnapshot,
  CompressionModelDescriptor,
  ConvertedPiSession,
  SemanticCompactionPlan,
  SemanticSummaryCall,
} from "./types";
import {
  validateConvertedPiSessionData,
  validateIsolatedResponsesReplay,
  validateResponsesReplay,
} from "./validation";

const PREFLIGHT_TOKEN_VERSION = 1;
const PREFLIGHT_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_LIST_LIMIT = 500;

/**
 * Stop before the atomic publication commit point when the browser cancels.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertImportNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new CodexImportError("IMPORT_CANCELLED", "Codex session import was cancelled before publication");
  }
}

declare global {
  var __piCodexImportTokenSecret: Buffer | undefined;
}

interface CodexImportServiceOptions {
  agentDir: string;
  codexHome: string;
  now?: () => number;
  createModelRuntime?: () => Promise<ModelRuntime>;
}

interface PreflightTokenPayload {
  version: 1;
  expiresAt: number;
  threadId: string;
  sourceVersion: string;
  targetCwd: string;
  sessionId: string;
  importedAt: string;
  planHash: string;
  reimportChanged: boolean;
  crossProviderConfirmed: boolean;
  crossProviderModel?: { provider: string; modelId: string };
}

interface ModelPlanningContext {
  runtime: ModelRuntime;
  currentModel: CompressionModelDescriptor;
  availableModels: CompressionModelDescriptor[];
}

interface PreparedImport {
  candidate: CodexCandidate;
  snapshot: CodexRolloutSnapshot;
  conversion: ConvertedPiSession;
  targetCwd: string;
  plan: SemanticCompactionPlan;
  models: ModelPlanningContext;
}

/**
 * Map Codex's Desktop provider label to Pi's subscription provider label.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function mapSourceProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "openai" || normalized === "codex" ? "openai-codex" : normalized;
}

/**
 * Derive stable Pi identity fields so a fresh preflight can resume signed checkpoints.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function stableImportIdentity(threadId: string, snapshot: CodexRolloutSnapshot): { sessionId: string; importedAt: string } {
  const bytes = createHash("sha256").update(threadId).update("\0").update(snapshot.sourceVersion).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return {
    sessionId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    importedAt: new Date(snapshot.sourceMtimeMs).toISOString(),
  };
}

/**
 * Return the process-local HMAC secret that survives Next.js hot reload.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function getPreflightTokenSecret(): Buffer {
  globalThis.__piCodexImportTokenSecret ??= randomBytes(32);
  return globalThis.__piCodexImportTokenSecret;
}

/**
 * Hide the raw source hash while binding a token to one exact rollout version.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function sourceVersionTag(sourceVersion: string): string {
  return createHmac("sha256", getPreflightTokenSecret())
    .update("codex-source-version\0")
    .update(sourceVersion)
    .digest("base64url");
}

/**
 * Encode and authenticate one short-lived preflight decision.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function signPreflightToken(payload: PreflightTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", getPreflightTokenSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

/**
 * Verify a preflight token before any source or destination operation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function verifyPreflightToken(token: string, now: number): PreflightTokenPayload {
  const [encoded, suppliedSignature, extra] = token.split(".");
  if (!encoded || !suppliedSignature || extra) {
    throw new CodexImportError("INVALID_PREFLIGHT_TOKEN", "Codex import preflight token is invalid");
  }
  const expected = createHmac("sha256", getPreflightTokenSecret()).update(encoded).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new CodexImportError("INVALID_PREFLIGHT_TOKEN", "Codex import preflight token is invalid");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new CodexImportError("INVALID_PREFLIGHT_TOKEN", "Codex import preflight token is invalid");
  }
  let payload: PreflightTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PreflightTokenPayload;
  } catch {
    throw new CodexImportError("INVALID_PREFLIGHT_TOKEN", "Codex import preflight token is invalid");
  }
  if (payload.version !== PREFLIGHT_TOKEN_VERSION || !payload.threadId || !payload.sourceVersion
    || !payload.targetCwd || !payload.sessionId || !payload.importedAt || !payload.planHash
    || Number.isNaN(Date.parse(payload.importedAt)) || !Number.isFinite(payload.expiresAt)) {
    throw new CodexImportError("INVALID_PREFLIGHT_TOKEN", "Codex import preflight token is incomplete");
  }
  if (payload.expiresAt < now) {
    throw new CodexImportError("PREFLIGHT_TOKEN_EXPIRED", "Codex import preflight has expired; run it again");
  }
  return payload;
}

/**
 * Return a public candidate without rollout paths, source hashes, or SQLite internals.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function toPublicCodexCandidate(candidate: CodexCandidate): CodexImportCandidateInfo {
  return {
    id: candidate.id,
    name: candidate.name,
    initialCwd: candidate.initialCwd,
    effectiveCwd: candidate.effectiveCwd,
    workspaceRoots: [...candidate.workspaceRoots],
    sandboxWritableRoots: [...candidate.sandboxWritableRoots],
    cwdExists: candidate.cwdExists,
    archived: candidate.archived,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    sourceKind: candidate.sourceKind,
    modelProvider: candidate.modelProvider,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    recordCount: candidate.recordCount,
    visibleUserCount: candidate.visibleUserCount,
    assistantCount: candidate.assistantCount,
    toolCallCount: candidate.toolCallCount,
    toolResultCount: candidate.toolResultCount,
    codexCompactionCount: candidate.codexCompactionCount,
    estimatedTokens: candidate.estimatedTokens,
    importState: candidate.importState,
    importedSessionId: candidate.importedSessionId,
    warnings: candidate.warnings.map((warning) => ({ ...warning })),
    riskCodes: [...candidate.riskCodes],
    importable: candidate.sourceKind === "root" && candidate.visibleUserCount > 0,
  };
}

/**
 * Return only the compaction plan fields intended for the browser.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function toPublicCompactionPlan(plan: SemanticCompactionPlan): CodexCompactionPlanInfo {
  return {
    mode: plan.mode,
    originalTokens: plan.originalTokens,
    keptTokens: plan.keptTokens,
    safeInputCapacity: plan.safeInputCapacity,
    estimatedChunks: plan.estimatedChunks,
    estimatedLayers: plan.estimatedLayers,
    estimatedCalls: plan.estimatedCalls,
    compressionModel: {
      provider: plan.compressionModel.provider,
      modelId: plan.compressionModel.id,
      contextWindow: plan.compressionModel.contextWindow,
    },
    crossProvider: plan.crossProvider,
    lossy: plan.lossy,
  };
}

/**
 * Resolve the selected candidate again from SQLite instead of trusting browser metadata.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function findAuthoritativeCandidate(
  options: CodexImportServiceOptions,
  threadId: string,
): Promise<CodexCandidate> {
  return getCodexCandidateById({
    codexHome: options.codexHome,
    agentDir: options.agentDir,
    threadId,
  });
}

/**
 * Hash the real API family and normalized endpoint without exposing either to the browser.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function modelEndpointFingerprint(
  model: Model<Api>,
  effectiveBaseUrl = model.baseUrl,
  headers: Record<string, string | null | undefined> = {},
): string {
  let normalizedBaseUrl = effectiveBaseUrl.trim();
  try {
    const parsed = new URL(normalizedBaseUrl);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    normalizedBaseUrl = parsed.toString();
  } catch {
    // Preserve an invalid endpoint exactly so request preparation will fail closed later.
  }
  const sensitiveHeaders = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;
  const routingHeaders = Object.entries(headers)
    .filter((entry): entry is [string, string] => (
      !sensitiveHeaders.test(entry[0]) && typeof entry[1] === "string"
    ))
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify({
      provider: model.provider,
      api: model.api,
      baseUrl: normalizedBaseUrl,
      routingHeaders,
    }))
    .digest("hex");
}

/**
 * Convert one authenticated Pi model into an import compaction descriptor.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function describeModel(
  runtime: ModelRuntime,
  model: Model<Api>,
  available = true,
): Promise<CompressionModelDescriptor> {
  let effectiveBaseUrl = model.baseUrl;
  let effectiveHeaders: Record<string, string | null | undefined> = { ...(model.headers ?? {}) };
  if (typeof runtime.getAuth === "function") {
    const resolution = await runtime.getAuth(model);
    if (resolution?.auth.baseUrl) effectiveBaseUrl = resolution.auth.baseUrl;
    effectiveHeaders = { ...effectiveHeaders, ...(resolution?.auth.headers ?? {}) };
  }
  return {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    endpointFingerprint: modelEndpointFingerprint(model, effectiveBaseUrl, effectiveHeaders),
    available,
    model,
  };
}

/**
 * Load model availability and preserve the source continuation model separately.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function createModelPlanningContext(
  options: CodexImportServiceOptions,
  inspection: CodexRolloutInspection,
): Promise<ModelPlanningContext> {
  const runtime = options.createModelRuntime
    ? await options.createModelRuntime()
    : await ModelRuntime.create({
        authPath: join(options.agentDir, "auth.json"),
        modelsPath: existsSync(join(options.agentDir, "models.json"))
          ? join(options.agentDir, "models.json")
          : null,
        modelsStorePath: join(options.agentDir, "models-store.json"),
      });
  const available = [...await runtime.getAvailable()];
  const sourceProvider = mapSourceProvider(inspection.modelProvider || "openai");
  const recordedSourceModelId = inspection.model;
  const sourceModelId = recordedSourceModelId || "codex-imported";
  const catalogModel = recordedSourceModelId ? runtime.getModel(sourceProvider, recordedSourceModelId) : undefined;
  const fallbackModel = recordedSourceModelId
    ? undefined
    : available.find((model) => model.provider === sourceProvider);
  const selectedModel = catalogModel ?? fallbackModel;
  const contextWindow = inspection.contextWindow ?? selectedModel?.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    throw new CodexImportError("MODEL_CONTEXT_WINDOW_UNKNOWN", "The source model context window is unknown");
  }
  const currentModel: CompressionModelDescriptor = selectedModel
    ? await describeModel(runtime, selectedModel, available.some((model) => (
        model.provider === selectedModel.provider && model.id === selectedModel.id
      )))
    : {
        provider: sourceProvider,
        id: sourceModelId,
        contextWindow,
        maxTokens: Math.max(1, Math.min(16_384, Math.floor(contextWindow * 0.1))),
        endpointFingerprint: createHash("sha256").update(`unresolved:${sourceProvider}`).digest("hex"),
        available: false,
      };
  currentModel.contextWindow = contextWindow;
  const availableModels = await Promise.all(available.map((model) => describeModel(runtime, model)));
  if (!availableModels.some((model) => model.provider === currentModel.provider && model.id === currentModel.id)) {
    availableModels.push(currentModel);
  }
  return { runtime, currentModel, availableModels };
}

/**
 * Build and locally validate conversion plus compaction plan from one immutable snapshot.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function prepareSnapshotImport(
  options: CodexImportServiceOptions,
  candidate: CodexCandidate,
  snapshot: CodexRolloutSnapshot,
  request: CodexImportPreflightRequest,
  identity: { sessionId: string; importedAt: string },
): Promise<PreparedImport> {
  const inspection = await inspectCodexRollout({
    threadId: candidate.id,
    rolloutPath: snapshot.path,
    sqliteSource: candidate.sqliteSource,
    sqliteThreadSource: candidate.sqliteThreadSource,
    sqliteAgentRole: candidate.agentRole,
    modelProvider: candidate.modelProvider,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    expectedSnapshotHash: snapshot.hash,
    expectedSnapshotSize: snapshot.size,
  });
  if (inspection.sourceKind !== "root" || candidate.sourceKind !== "root") {
    throw new CodexImportError("NON_ROOT_SESSION_REJECTED", "Only top-level Codex sessions can be imported");
  }
  const targetCwd = resolveCodexImportCwd(inspection.effectiveCwd, request.remapCwd);
  const conversion = await convertCodexRollout({
    candidate,
    inspection,
    snapshotPath: snapshot.path,
    snapshotHash: snapshot.hash,
    snapshotSize: snapshot.size,
    targetCwd,
    sourceVersion: snapshot.sourceVersion,
    sessionId: identity.sessionId,
    importedAt: identity.importedAt,
  });
  validateConvertedPiSessionData(conversion);
  await validateResponsesReplay(conversion);
  await validateIsolatedResponsesReplay(conversion);
  const models = await createModelPlanningContext(options, inspection);
  const plan = planSemanticCompaction({
    entries: conversion.entries,
    semanticHints: conversion.semanticHints,
    currentModel: models.currentModel,
    availableModels: models.availableModels,
    sourceVersion: snapshot.sourceVersion,
    crossProviderConfirmed: request.crossProviderConfirmed,
    crossProviderModel: request.crossProviderModel,
  });
  await verifyRolloutSnapshot(snapshot);
  return { candidate, snapshot, conversion, targetCwd, plan, models };
}

/**
 * Turn hierarchical child checkpoints into ordinary Pi messages for native summarization.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function summaryMessages(input: SemanticSummaryInput): AgentMessage[] {
  if (input.childSummaries.length === 0) return input.messages;
  return input.childSummaries.map((child, index) => ({
    role: "user",
    content: `Checkpoint ${index + 1} (${child.entryIds.length} source entries, SHA-256 ${child.hash}):\n\n${child.text}`,
    timestamp: Date.now(),
  }));
}

/**
 * Build explicit semantic continuity and coverage instructions for Pi's native summarizer.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function summaryInstructions(call: SemanticSummaryCall, input: SemanticSummaryInput): string {
  const continuity = input.continuity
    ? `\nContinuity:\n- Original request: ${input.continuity.originalRequest}\n- Current goal: ${input.continuity.currentGoal}\n- Dependencies: ${input.continuity.dependencies.join(", ") || "none"}`
    : "";
  return `${input.instructions}\nPhase: ${call.phase}; hierarchy level: ${call.level}.\n`
    + `Coverage: ${input.coverage.entryIds.length} source entries; ${input.coverage.toolCallCount} tool calls; input SHA-256 ${input.coverage.inputHash}.\n`
    + "Distinguish abandoned attempts, later corrections, and the current final state. Preserve file operations and unfinished work."
    + continuity;
}

/**
 * Execute one summary call through Pi's native compaction summary implementation.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function runNativeSummary(
  runtime: ModelRuntime,
  call: SemanticSummaryCall,
  input: SemanticSummaryInput,
  runtimePolicy: CodexImportRuntimePolicy,
  signal?: AbortSignal,
): Promise<{ text: string; usage: Awaited<ReturnType<typeof generateSummaryWithUsage>>["usage"] }> {
  const model = input.model.model ?? runtime.getModel(input.model.provider, input.model.id);
  if (!model) throw new CodexImportError("COMPACTION_MODEL_UNAVAILABLE", "The planned compaction model is no longer available");
  const requestRuntime = runtime as unknown as {
    prepareRequest: (
      selected: Parameters<StreamFn>[0],
      options: Parameters<StreamFn>[2],
    ) => Promise<{
      model: Parameters<StreamFn>[0];
      options: NonNullable<Parameters<StreamFn>[2]>;
      provider: { streamSimple: StreamFn };
    }>;
  };
  const streamFn: StreamFn = async (selected, context, streamOptions) => {
    const prepared = await requestRuntime.prepareRequest(selected, streamOptions);
    const effectiveHeaders = {
      ...(prepared.model.headers ?? {}),
      ...(prepared.options.headers ?? {}),
    };
    if (input.model.endpointFingerprint
      && modelEndpointFingerprint(prepared.model, prepared.model.baseUrl, effectiveHeaders)
        !== input.model.endpointFingerprint) {
      throw new CodexImportError("PREFLIGHT_PLAN_CHANGED", "The compaction API endpoint changed after preflight");
    }
    return prepared.provider.streamSimple(prepared.model, context, prepared.options);
  };
  const isolatedMessages = projectImportedCodexProviderHistory(
    summaryMessages(input) as Message[],
    runtimePolicy,
  ) as AgentMessage[];
  return generateSummaryWithUsage(
    isolatedMessages,
    model,
    input.reserveTokens,
    undefined,
    undefined,
    signal,
    summaryInstructions(call, input),
    input.previousSummary,
    undefined,
    streamFn,
  );
}

/**
 * Apply an optional semantic summary while retaining every converted source entry in Pi JSONL.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function compactPreparedImport(prepared: PreparedImport, agentDir: string, signal?: AbortSignal): Promise<void> {
  if (prepared.plan.mode === "none") return;
  const runtimePolicy = readCodexImportRuntimePolicy(prepared.conversion.entries);
  if (!runtimePolicy) {
    throw new CodexImportError("MISSING_IMPORT_RUNTIME_POLICY", "Converted history lacks a valid runtime isolation marker");
  }
  const checkpointStore = createFileCompactionCheckpointStore({
    agentDir,
    threadId: prepared.candidate.id,
    sourceVersion: prepared.snapshot.sourceVersion,
    planHash: prepared.plan.planHash,
  });
  const result = await executeSemanticCompactionPlan({
    plan: prepared.plan,
    entries: prepared.conversion.entries,
    checkpointStore,
    summarize: (call, input) => runNativeSummary(
      prepared.models.runtime,
      call,
      input,
      runtimePolicy,
      signal,
    ),
  });
  prepared.conversion.entries = applySemanticCompaction({
    entries: prepared.conversion.entries,
    plan: prepared.plan,
    result,
  });
  prepared.conversion.provenance.compaction = {
    mode: prepared.plan.mode,
    planHash: prepared.plan.planHash,
    sourceEntryCount: prepared.plan.summaryEntryIds.length,
    keptEntryCount: prepared.plan.keptEntryIds.length,
    callCount: result.callCount,
    checkpointHits: result.checkpointHits,
    compressionModel: `${prepared.plan.compressionModel.provider}/${prepared.plan.compressionModel.id}`,
    lossy: true,
  };
  prepared.conversion.warnings.push({
    code: "LOSSY_COMPACTION",
    message: "Imported active context uses a lossy semantic summary; complete converted source history remains in Pi JSONL",
  });
  prepared.conversion.provenance.warnings = prepared.conversion.warnings;
  validateConvertedPiSessionData(prepared.conversion);
  await validateResponsesReplay(prepared.conversion);
  await validateIsolatedResponsesReplay(prepared.conversion);
}

/**
 * Remove a snapshot only while its owner capability still matches.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function cleanupSnapshotBestEffort(snapshot: CodexRolloutSnapshot | undefined): void {
  if (!snapshot) return;
  try {
    cleanupRolloutSnapshot(snapshot);
  } catch {
    // An unowned or changed path is intentionally left untouched for safe operator cleanup.
  }
}

/**
 * Create the production Codex import service over fixed server-side roots.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createCodexImportService(options: CodexImportServiceOptions) {
  const agentDir = assertCodexImportAgentDir(options.agentDir, {
    testMode: process.env.PI_WEB_TEST_MODE === "1",
  });
  const codexHome = resolve(options.codexHome);
  const fixed = { ...options, agentDir, codexHome };
  const now = options.now ?? Date.now;

  return {
    /**
     * List source metadata only; transcript bodies and rollout paths never leave the server.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    async list(filters: CodexCandidateFilters = {}): Promise<CodexImportCandidateInfo[]> {
      const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(filters.limit ?? 200)));
      const candidates = await listCodexCandidates({
        codexHome,
        agentDir,
        filters: { ...filters, limit },
      });
      return candidates.map(toPublicCodexCandidate);
    },

    /**
     * Return one authoritative metadata-only detail record.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    async detail(threadId: string): Promise<CodexImportCandidateInfo> {
      return toPublicCodexCandidate(await findAuthoritativeCandidate(fixed, threadId));
    },

    /**
     * Snapshot, convert, validate, and sign one import plan without publishing it.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    async preflight(request: CodexImportPreflightRequest): Promise<CodexImportPreflightResponse> {
      return withCodexImportLock({ agentDir, threadId: request.threadId }, async () => {
        const candidate = await findAuthoritativeCandidate(fixed, request.threadId);
        let snapshot: CodexRolloutSnapshot | undefined;
        try {
          snapshot = await createStableRolloutSnapshot({
            sourcePath: candidate.rolloutPath,
            codexHome,
            agentDir,
            threadId: candidate.id,
          });
          const state = await getCodexImportState(agentDir, candidate.id, snapshot.sourceVersion);
          if (state.status === "already_imported") {
            return {
              status: "already_imported",
              session: toPublicCodexCandidate({ ...candidate, importState: state.status, importedSessionId: state.sessionId }),
              targetCwd: candidate.effectiveCwd,
              warnings: candidate.warnings,
              existingSessionId: state.sessionId,
            };
          }
          if (state.status === "source_changed" && request.reimportChanged !== true) {
            throw new CodexImportError(
              "SOURCE_CHANGED_CONFIRMATION_REQUIRED",
              "The Codex source changed after a prior import; confirm importing it as a new Pi session",
            );
          }
          const identity = stableImportIdentity(candidate.id, snapshot);
          const prepared = await prepareSnapshotImport(fixed, candidate, snapshot, request, identity);
          const payload: PreflightTokenPayload = {
            version: PREFLIGHT_TOKEN_VERSION,
            expiresAt: now() + PREFLIGHT_TOKEN_TTL_MS,
            threadId: candidate.id,
            sourceVersion: sourceVersionTag(snapshot.sourceVersion),
            targetCwd: prepared.targetCwd,
            sessionId: identity.sessionId,
            importedAt: identity.importedAt,
            planHash: prepared.plan.planHash,
            reimportChanged: request.reimportChanged === true,
            crossProviderConfirmed: request.crossProviderConfirmed === true,
            crossProviderModel: request.crossProviderModel,
          };
          return {
            status: "ready",
            session: toPublicCodexCandidate(candidate),
            targetCwd: prepared.targetCwd,
            preflightToken: signPreflightToken(payload),
            compaction: toPublicCompactionPlan(prepared.plan),
            warnings: prepared.conversion.warnings,
          };
        } finally {
          cleanupSnapshotBestEffort(snapshot);
        }
      });
    },

    /**
     * Rebuild a signed plan, execute summaries, revalidate, and atomically publish one session.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    async import(preflightToken: string, signal?: AbortSignal): Promise<CodexImportRunResponse> {
      const token = verifyPreflightToken(preflightToken, now());
      assertImportNotCancelled(signal);
      return withCodexImportLock({ agentDir, threadId: token.threadId }, async () => {
        assertImportNotCancelled(signal);
        const candidate = await findAuthoritativeCandidate(fixed, token.threadId);
        assertImportNotCancelled(signal);
        let snapshot: CodexRolloutSnapshot | undefined;
        try {
          snapshot = await createStableRolloutSnapshot({
            sourcePath: candidate.rolloutPath,
            codexHome,
            agentDir,
            threadId: candidate.id,
          });
          assertImportNotCancelled(signal);
          if (sourceVersionTag(snapshot.sourceVersion) !== token.sourceVersion) {
            throw new CodexImportError("SOURCE_CHANGED", "The Codex source changed after preflight; run preflight again");
          }
          const state = await getCodexImportState(agentDir, candidate.id, snapshot.sourceVersion);
          if (state.status === "already_imported" && state.sessionId) {
            return {
              status: "already_imported",
              sourceThreadId: candidate.id,
              sessionId: state.sessionId,
              cwd: token.targetCwd,
              warnings: state.warnings ?? candidate.warnings,
            };
          }
          if (state.status === "source_changed" && !token.reimportChanged) {
            throw new CodexImportError("SOURCE_CHANGED_CONFIRMATION_REQUIRED", "Explicit source-change confirmation is required");
          }
          const request: CodexImportPreflightRequest = {
            threadId: token.threadId,
            remapCwd: token.targetCwd,
            reimportChanged: token.reimportChanged,
            crossProviderConfirmed: token.crossProviderConfirmed,
            crossProviderModel: token.crossProviderModel,
          };
          const prepared = await prepareSnapshotImport(fixed, candidate, snapshot, request, {
            sessionId: token.sessionId,
            importedAt: token.importedAt,
          });
          assertImportNotCancelled(signal);
          if (prepared.targetCwd !== token.targetCwd || prepared.plan.planHash !== token.planHash) {
            throw new CodexImportError("PREFLIGHT_PLAN_CHANGED", "Import conditions changed after preflight; run it again");
          }
          await compactPreparedImport(prepared, agentDir, signal);
          assertImportNotCancelled(signal);
          await verifyRolloutSnapshot(snapshot);
          assertImportNotCancelled(signal);
          // Atomic publication is the commit point; cancellation after this check is reconciled by the client.
          const published = await publishConvertedPiSession({
            agentDir,
            conversion: prepared.conversion,
            signal,
          });
          invalidateSessionListCache();
          allowFileRoot(prepared.targetCwd);
          if (prepared.plan.mode !== "none") {
            await createFileCompactionCheckpointStore({
              agentDir,
              threadId: candidate.id,
              sourceVersion: snapshot.sourceVersion,
              planHash: prepared.plan.planHash,
            }).remove().catch(() => undefined);
          }
          return {
            status: "imported",
            sourceThreadId: candidate.id,
            sessionId: published.sessionId,
            cwd: published.cwd,
            warnings: prepared.conversion.warnings,
            compaction: toPublicCompactionPlan(prepared.plan),
          };
        } finally {
          cleanupSnapshotBestEffort(snapshot);
        }
      });
    },
  };
}

/**
 * Resolve the singleton-style runtime service from server-owned environment and home paths.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createRuntimeCodexImportService() {
  const agentDir = getAgentDir();
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return createCodexImportService({ agentDir, codexHome });
}
