"use client";

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { CodexImportCandidateInfo, CodexImportRunResponse } from "@/lib/api-types";
import {
  CodexImportClientError,
  fetchCodexImportDetail,
  preflightCodexImport,
  runCodexImport,
} from "@/lib/codex-import-client";
import type { CodexImportBusyState, CodexImportProgress, CodexImportRowState } from "./types";

type RowStates = Record<string, CodexImportRowState>;
type BooleanMap = Record<string, boolean>;
type StringMap = Record<string, string>;
type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface CommonActionOptions {
  busy: CodexImportBusyState;
  setBusy: StateSetter<CodexImportBusyState>;
  setProgress: StateSetter<CodexImportProgress | null>;
  operationAbortRef: MutableRefObject<AbortController | null>;
  sessions: CodexImportCandidateInfo[];
  selectedIds: Set<string>;
  setRowStates: StateSetter<RowStates>;
}

interface PreflightActionOptions extends CommonActionOptions {
  remaps: StringMap;
  reimportConfirmed: BooleanMap;
  crossProviderConfirmed: BooleanMap;
  crossProviderModels: StringMap;
  setCrossProviderModels: StateSetter<StringMap>;
  refreshSession: (threadId: string, signal?: AbortSignal) => Promise<void>;
}

interface RunActionOptions extends CommonActionOptions {
  canImport: boolean;
  rowStates: RowStates;
  remaps: StringMap;
  setSessions: StateSetter<CodexImportCandidateInfo[]>;
  refreshSession: (threadId: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Extract safe model identifiers from a cross-provider preflight error.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function crossProviderOptions(error: CodexImportClientError): string[] | undefined {
  const values = error.details?.availableModels;
  if (!Array.isArray(values)) return undefined;
  const models = values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    return typeof model.provider === "string" && typeof model.modelId === "string"
      ? [`${model.provider}/${model.modelId}`]
      : [];
  });
  return models.length > 0 ? models : undefined;
}

/**
 * Parse a provider/model reference at its first slash.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function splitModelReference(value: string | undefined): { provider: string; modelId: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1
    ? { provider: value.slice(0, separator), modelId: value.slice(separator + 1) }
    : undefined;
}

/**
 * Pause briefly while an aborted connection crosses the publication commit point.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function reconciliationDelay(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 200));
}

/**
 * Build the sequential signed-preflight action for selected rows.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function useCodexPreflightAction(options: PreflightActionOptions) {
  return useCallback(async () => {
    if (options.selectedIds.size === 0 || options.busy || options.operationAbortRef.current) return;
    const controller = new AbortController();
    options.operationAbortRef.current = controller;
    const selected = options.sessions.filter((item) => options.selectedIds.has(item.id));
    options.setBusy("preflight");
    options.setProgress({ current: 0, total: selected.length });
    for (let index = 0; index < selected.length; index += 1) {
      const session = selected[index];
      if (controller.signal.aborted) break;
      options.setProgress({ current: index + 1, total: selected.length });
      options.setRowStates((current) => ({ ...current, [session.id]: { phase: "preflighting" } }));
      try {
        const preflight = await preflightCodexImport({
          threadId: session.id,
          remapCwd: options.remaps[session.id],
          reimportChanged: options.reimportConfirmed[session.id] === true,
          crossProviderConfirmed: options.crossProviderConfirmed[session.id] === true,
          crossProviderModel: splitModelReference(options.crossProviderModels[session.id]),
        }, controller.signal);
        options.setRowStates((current) => ({
          ...current,
          [session.id]: {
            phase: preflight.status === "already_imported" ? "already" : "ready",
            preflight,
          },
        }));
      } catch (error) {
        if (controller.signal.aborted) {
          options.setRowStates((current) => ({ ...current, [session.id]: { phase: "idle" } }));
          break;
        }
        const clientError = error instanceof CodexImportClientError ? error : undefined;
        const modelOptions = clientError ? crossProviderOptions(clientError) : undefined;
        if (modelOptions?.length && !options.crossProviderModels[session.id]) {
          options.setCrossProviderModels((current) => ({ ...current, [session.id]: modelOptions[0] }));
        }
        if (["CWD_REMAP_REQUIRED", "SOURCE_CHANGED_CONFIRMATION_REQUIRED"].includes(clientError?.code ?? "")) {
          await options.refreshSession(session.id, controller.signal).catch(() => undefined);
        }
        options.setRowStates((current) => ({
          ...current,
          [session.id]: {
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
            errorCode: clientError?.code,
            crossProviderOptions: modelOptions,
          },
        }));
      }
    }
    options.operationAbortRef.current = null;
    options.setProgress(null);
    options.setBusy(null);
  }, [options]);
}

/**
 * Reconcile a canceled request with the server's atomic publication result.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function reconcileCancelledImport(
  session: CodexImportCandidateInfo,
  remappedCwd: string | undefined,
  setSessions: StateSetter<CodexImportCandidateInfo[]>,
): Promise<CodexImportRunResponse | undefined> {
  let reconciled: CodexImportCandidateInfo | undefined;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      reconciled = await fetchCodexImportDetail(session.id);
      setSessions((current) => current.map((item) => item.id === session.id ? reconciled! : item));
      if (reconciled.importState === "already_imported" && reconciled.importedSessionId) break;
    } catch {
      // Retry because cancellation can race the atomic publication commit point.
    }
    await reconciliationDelay();
  }
  if (reconciled?.importState !== "already_imported" || !reconciled.importedSessionId) return undefined;
  return {
    status: "already_imported",
    sourceThreadId: session.id,
    sessionId: reconciled.importedSessionId,
    cwd: remappedCwd ?? reconciled.effectiveCwd,
    warnings: reconciled.warnings,
  };
}

/**
 * Build the sequential atomic-publication action for ready rows.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function useCodexRunAction(options: RunActionOptions) {
  return useCallback(async (): Promise<CodexImportRunResponse[]> => {
    if (!options.canImport || options.busy || options.operationAbortRef.current) return [];
    const controller = new AbortController();
    options.operationAbortRef.current = controller;
    const selected = options.sessions.filter((item) => options.selectedIds.has(item.id));
    options.setBusy("import");
    options.setProgress({ current: 0, total: selected.length });
    const results: CodexImportRunResponse[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const session = selected[index];
      if (controller.signal.aborted) break;
      options.setProgress({ current: index + 1, total: selected.length });
      const state = options.rowStates[session.id];
      if (state?.phase === "already" && state.preflight?.existingSessionId) {
        results.push({
          status: "already_imported",
          sourceThreadId: session.id,
          sessionId: state.preflight.existingSessionId,
          cwd: state.preflight.targetCwd,
          warnings: state.preflight.warnings,
        });
        continue;
      }
      if (!state?.preflight?.preflightToken) continue;
      options.setRowStates((current) => ({ ...current, [session.id]: { ...state, phase: "importing" } }));
      try {
        const result = await runCodexImport(
          { preflightToken: state.preflight.preflightToken },
          controller.signal,
        );
        results.push(result);
        options.setRowStates((current) => ({
          ...current,
          [session.id]: { ...current[session.id], phase: result.status === "imported" ? "imported" : "already", result },
        }));
        await options.refreshSession(session.id, controller.signal).catch(() => undefined);
      } catch (error) {
        if (controller.signal.aborted) {
          const result = await reconcileCancelledImport(
            session,
            options.remaps[session.id],
            options.setSessions,
          );
          if (result) results.push(result);
          options.setRowStates((current) => ({
            ...current,
            [session.id]: {
              ...current[session.id],
              phase: result ? "already" : "ready",
              ...(result ? { result } : {}),
            },
          }));
          break;
        }
        options.setRowStates((current) => ({
          ...current,
          [session.id]: {
            ...current[session.id],
            phase: "error",
            error: error instanceof Error ? error.message : String(error),
            errorCode: error instanceof CodexImportClientError ? error.code : undefined,
          },
        }));
      }
    }
    options.operationAbortRef.current = null;
    options.setProgress(null);
    options.setBusy(null);
    return results;
  }, [options]);
}
