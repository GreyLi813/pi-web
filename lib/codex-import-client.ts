import type {
  CodexImportCandidateInfo,
  CodexImportListResponse,
  CodexImportPreflightRequest,
  CodexImportPreflightResponse,
  CodexImportRunRequest,
  CodexImportRunResponse,
} from "./api-types";

export interface CodexImportFilters {
  name: string;
  workspace: string;
  sandbox: string;
  cwd: string;
  includeArchived: boolean;
  includeSubagents: boolean;
  includeGuardians: boolean;
}

/**
 * Browser error preserving stable server code and non-transcript diagnostics.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export class CodexImportClientError extends Error {
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CodexImportClientError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Parse a JSON API response and preserve its stable error code.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function readApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json() as T & {
    error?: string;
    code?: string;
    details?: Record<string, unknown>;
  };
  if (!response.ok || data.error) {
    throw new CodexImportClientError(data.error ?? `HTTP ${response.status}`, data.code, data.details);
  }
  return data;
}

/**
 * Enumerate metadata-only candidates with independent server-side filters.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function fetchCodexImportCandidates(
  filters: CodexImportFilters,
  signal?: AbortSignal,
): Promise<CodexImportCandidateInfo[]> {
  const params = new URLSearchParams();
  for (const key of ["name", "workspace", "sandbox", "cwd"] as const) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  if (filters.includeArchived) params.set("includeArchived", "1");
  if (filters.includeSubagents) params.set("includeSubagents", "1");
  if (filters.includeGuardians) params.set("includeGuardians", "1");
  params.set("limit", "500");
  const response = await fetch(`/api/codex-import?${params}`, { signal, cache: "no-store" });
  return (await readApiResponse<CodexImportListResponse>(response)).sessions;
}

/**
 * Load one metadata-only candidate detail.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function fetchCodexImportDetail(
  threadId: string,
  signal?: AbortSignal,
): Promise<CodexImportCandidateInfo> {
  const response = await fetch(`/api/codex-import/${encodeURIComponent(threadId)}`, {
    signal,
    cache: "no-store",
  });
  return (await readApiResponse<{ session: CodexImportCandidateInfo }>(response)).session;
}

/**
 * Snapshot and validate one explicit candidate without publishing it.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function preflightCodexImport(
  request: CodexImportPreflightRequest,
  signal?: AbortSignal,
): Promise<CodexImportPreflightResponse> {
  const response = await fetch("/api/codex-import/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return readApiResponse<CodexImportPreflightResponse>(response);
}

/**
 * Publish one session from its signed preflight token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function runCodexImport(
  request: CodexImportRunRequest,
  signal?: AbortSignal,
): Promise<CodexImportRunResponse> {
  const response = await fetch("/api/codex-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  return readApiResponse<CodexImportRunResponse>(response);
}
