import type { CodexImportPreflightResponse, CodexImportRunResponse } from "@/lib/api-types";

export type CodexImportRowPhase = "idle" | "preflighting" | "ready" | "importing" | "imported" | "already" | "error";
export type CodexImportBusyState = "preflight" | "import" | null;
export interface CodexImportProgress { current: number; total: number }

export interface CodexImportRowState {
  phase: CodexImportRowPhase;
  preflight?: CodexImportPreflightResponse;
  result?: CodexImportRunResponse;
  error?: string;
  errorCode?: string;
  crossProviderOptions?: string[];
}
