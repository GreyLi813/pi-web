import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type CodexThreadKind = "root" | "subagent" | "guardian" | "unknown";
export type CodexImportStateName = "available" | "already_imported" | "source_changed";

export interface CodexImportWarning {
  code: string;
  message: string;
  count?: number;
}

export interface CodexThreadSourceSignals {
  source?: unknown;
  threadSource?: unknown;
  agentRole?: unknown;
  rolloutSource?: unknown;
  rolloutThreadSource?: unknown;
}

export interface CodexCandidate {
  id: string;
  name: string;
  rolloutPath: string;
  initialCwd: string;
  effectiveCwd: string;
  workspaceRoots: string[];
  sandboxWritableRoots: string[];
  cwdExists: boolean;
  archived: boolean;
  archivedAt?: number;
  createdAt?: string;
  updatedAt?: string;
  sourceKind: CodexThreadKind;
  sqliteSource?: unknown;
  sqliteThreadSource?: unknown;
  agentRole?: unknown;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  cliVersion?: string;
  sourceVersion: string;
  recordCount: number;
  visibleUserCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  codexCompactionCount: number;
  estimatedTokens: number;
  importState: CodexImportStateName;
  importedSessionId?: string;
  warnings: CodexImportWarning[];
  riskCodes: string[];
}

export interface CodexCandidateFilters {
  name?: string;
  workspace?: string;
  sandbox?: string;
  cwd?: string;
  includeArchived?: boolean;
  includeSubagents?: boolean;
  includeGuardians?: boolean;
  limit?: number;
}

export interface CodexRolloutInspection {
  threadId: string;
  sourceSessionId: string;
  sourceKind: CodexThreadKind;
  matchingSessionMetaCount: number;
  createdAt: string;
  initialCwd: string;
  effectiveCwd: string;
  workspaceRoots: string[];
  sandboxWritableRoots: string[];
  modelProvider: string;
  model: string;
  reasoningEffort: string;
  contextWindow?: number;
  recordCount: number;
  visibleUserCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  codexCompactionCount: number;
  estimatedTokens: number;
  warnings: CodexImportWarning[];
}

export interface CodexRolloutSnapshot {
  path: string;
  ownerPath: string;
  ownerToken: string;
  hash: string;
  size: number;
  sourceMtimeMs: number;
  sourceVersion: string;
}

export interface PiSessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface CodexSemanticHint {
  key: string;
  kind: "task" | "turn" | "compaction-boundary";
  entryIds: string[];
  complete: boolean;
  sourceStartLine?: number;
  sourceEndLine?: number;
}

export interface ConvertedPiSession {
  header: PiSessionHeader;
  entries: SessionEntry[];
  warnings: CodexImportWarning[];
  semanticHints: CodexSemanticHint[];
  provenance: Record<string, unknown>;
}

export interface PortableSessionValidation {
  toolCallCount: number;
  toolResultCount: number;
  syntheticToolResultCount: number;
  messageCount: number;
}

export interface CompressionModelDescriptor {
  provider: string;
  id: string;
  contextWindow: number;
  maxTokens: number;
  endpointFingerprint?: string;
  available?: boolean;
  model?: Model<Api>;
}

export interface SemanticFrame {
  id: string;
  entryIds: string[];
  messages: AgentMessage[];
  estimatedTokens: number;
  safeBoundary: boolean;
}

export interface SemanticUnit {
  id: string;
  entryIds: string[];
  messages: AgentMessage[];
  frames: SemanticFrame[];
  estimatedTokens: number;
  complete: boolean;
  toolCallCount: number;
  fileOperations: string[];
}

export interface SemanticSummaryChunk {
  id: string;
  level: number;
  entryIds: string[];
  unitIds: string[];
  estimatedTokens: number;
  inputRefs: string[];
  continuity?: {
    originalRequest: string;
    currentGoal: string;
    dependencies: string[];
  };
}

export interface SemanticSummaryCall extends SemanticSummaryChunk {
  phase: "single" | "leaf" | "merge" | "final";
  dependsOn: string[];
}

export type SemanticCompactionMode = "none" | "single" | "hierarchical";

export interface SemanticCompactionPlan {
  mode: SemanticCompactionMode;
  planHash: string;
  sourceVersion: string;
  originalTokens: number;
  keptTokens: number;
  safeInputCapacity: number;
  estimatedChunks: number;
  estimatedLayers: number;
  estimatedCalls: number;
  lossless: boolean;
  lossy: boolean;
  crossProvider: boolean;
  compressionModel: CompressionModelDescriptor;
  firstKeptEntryId: string | null;
  keptEntryIds: string[];
  summaryEntryIds: string[];
  units: SemanticUnit[];
  leafChunks: SemanticSummaryChunk[];
  calls: SemanticSummaryCall[];
  reserveTokens: number;
  safetyTokens: number;
  templateTokens: number;
}

export interface SemanticSummaryResult {
  summary: string;
  usage?: Usage;
  coveredEntryIds: string[];
  callCount: number;
  checkpointHits: number;
  nodes: Array<{
    id: string;
    level: number;
    entryIds: string[];
    hash: string;
    toolCallCount: number;
    fileOperations: string[];
  }>;
}

export interface SummaryCallResponse {
  text: string;
  usage?: Usage;
}

export interface CompactionCheckpointRecord {
  text: string;
  usage?: Usage;
  entryIds: string[];
  inputHash: string;
}

export interface CompactionCheckpointStore {
  load(callId: string): Promise<CompactionCheckpointRecord | undefined>;
  save(callId: string, record: CompactionCheckpointRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface ImportedCodexState {
  status: CodexImportStateName;
  sessionId?: string;
  filePath?: string;
  sourceVersion?: string;
  warnings?: CodexImportWarning[];
}
