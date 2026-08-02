import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent";

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

export type SkillInstallScope = "global" | "project";

export interface SkillInstallInfo {
  package: string;
  scope: SkillInstallScope;
  source: string;
  sourceType?: string;
  skillsShUrl?: string;
  skillPath?: string;
  ref?: string;
  versionHash?: string;
  canCheckForUpdates: boolean;
}

export type SkillUpdateState =
  | "up-to-date"
  | "update-available"
  | "unsupported"
  | "error";

export interface SkillUpdateResult {
  package: string;
  scope: SkillInstallScope;
  state: SkillUpdateState;
  currentVersion?: string;
  latestVersion?: string;
  message?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: {
    source?: string;
    scope?: string;
  };
  install?: SkillInstallInfo;
}

export interface SkillsResponse {
  skills: SkillInfo[];
  diagnostics: ResourceDiagnostic[];
  projectResourcesLoaded: boolean;
}

export interface ProjectTrustStatus {
  requiresTrust: boolean;
  trusted: boolean;
}

export type PluginScope = "global" | "project";
export type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";

export interface PluginResourceCounts {
  extensions: number;
  skills: number;
  prompts: number;
  themes: number;
}

export interface PluginDiagnostic {
  type: "warning" | "error";
  message: string;
  source?: string;
  path?: string;
}

export interface PluginResourceInfo {
  kind: PluginResourceKind;
  name: string;
  path: string;
  relativePath: string;
}

export interface PluginPackageInfo {
  source: string;
  scope: PluginScope;
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  packageName?: string;
  version?: string;
  configuredVersion?: string;
  counts: PluginResourceCounts;
  resources: PluginResourceInfo[];
  status: "loaded" | "installed" | "missing" | "disabled";
}

export interface PluginsResponse {
  packages: PluginPackageInfo[];
  totals: PluginResourceCounts;
  diagnostics: PluginDiagnostic[];
  projectResourcesLoaded: boolean;
}

export type CodexImportThreadKind = "root" | "subagent" | "guardian" | "unknown";
export type CodexImportSourceState = "available" | "already_imported" | "source_changed";

export interface CodexImportWarningInfo {
  code: string;
  message: string;
  count?: number;
}

export interface CodexImportCandidateInfo {
  id: string;
  name: string;
  initialCwd: string;
  effectiveCwd: string;
  workspaceRoots: string[];
  sandboxWritableRoots: string[];
  cwdExists: boolean;
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
  sourceKind: CodexImportThreadKind;
  modelProvider?: string;
  model?: string;
  reasoningEffort?: string;
  recordCount: number;
  visibleUserCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  codexCompactionCount: number;
  estimatedTokens: number;
  importState: CodexImportSourceState;
  importedSessionId?: string;
  warnings: CodexImportWarningInfo[];
  riskCodes: string[];
  importable: boolean;
}

export interface CodexImportListResponse {
  sessions: CodexImportCandidateInfo[];
  total: number;
}

export interface CodexCompactionPlanInfo {
  mode: "none" | "single" | "hierarchical";
  originalTokens: number;
  keptTokens: number;
  safeInputCapacity: number;
  estimatedChunks: number;
  estimatedLayers: number;
  estimatedCalls: number;
  compressionModel: { provider: string; modelId: string; contextWindow: number };
  crossProvider: boolean;
  lossy: boolean;
}

export interface CodexImportPreflightRequest {
  threadId: string;
  remapCwd?: string;
  reimportChanged?: boolean;
  crossProviderConfirmed?: boolean;
  crossProviderModel?: { provider: string; modelId: string };
}

export interface CodexImportPreflightResponse {
  status: "ready" | "already_imported";
  session: CodexImportCandidateInfo;
  targetCwd: string;
  preflightToken?: string;
  compaction?: CodexCompactionPlanInfo;
  warnings: CodexImportWarningInfo[];
  existingSessionId?: string;
}

export interface CodexImportRunRequest {
  preflightToken: string;
}

export interface CodexImportRunResponse {
  status: "imported" | "already_imported";
  sourceThreadId: string;
  sessionId: string;
  cwd: string;
  warnings: CodexImportWarningInfo[];
  compaction?: CodexCompactionPlanInfo;
}
