"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CodexImportCandidateInfo } from "@/lib/api-types";
import {
  CodexImportClientError,
  fetchCodexImportCandidates,
  fetchCodexImportDetail,
  type CodexImportFilters,
} from "@/lib/codex-import-client";
import { useCodexPreflightAction, useCodexRunAction } from "./codex-import/useCodexImportActions";
import type {
  CodexImportBusyState,
  CodexImportProgress,
  CodexImportRowState,
} from "./codex-import/types";

export type { CodexImportRowPhase, CodexImportRowState } from "./codex-import/types";

const DEFAULT_FILTERS: CodexImportFilters = {
  name: "",
  workspace: "",
  sandbox: "",
  cwd: "",
  includeArchived: false,
  includeSubagents: false,
  includeGuardians: false,
};

interface DiscoveryOptions {
  filters: CodexImportFilters;
  setSessions: Dispatch<SetStateAction<CodexImportCandidateInfo[]>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setActiveId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Discover authoritative candidates after a short independent-filter debounce.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function useCodexDiscovery(options: DiscoveryOptions) {
  const { filters, setSessions, setSelectedIds, setActiveId } = options;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setLoadError(null);
      setLoadErrorCode(null);
      void fetchCodexImportCandidates(filters, controller.signal)
        .then((items) => {
          if (controller.signal.aborted) return;
          setSessions(items);
          const visible = new Set(items.map((item) => item.id));
          setSelectedIds((current) => new Set([...current].filter((id) => visible.has(id))));
          setActiveId((current) => current && visible.has(current) ? current : items[0]?.id ?? null);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setLoadError(error instanceof Error ? error.message : String(error));
          setLoadErrorCode(error instanceof CodexImportClientError ? error.code ?? null : null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters, revision, setActiveId, setSelectedIds, setSessions]);
  const reload = useCallback(() => setRevision((current) => current + 1), []);
  return { loading, loadError, loadErrorCode, reload };
}

/**
 * Own selective Codex import discovery, preflight, confirmation, and sequential publication state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function useCodexImport() {
  const [filters, setFilters] = useState<CodexImportFilters>(DEFAULT_FILTERS);
  const [sessions, setSessions] = useState<CodexImportCandidateInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rowStates, setRowStates] = useState<Record<string, CodexImportRowState>>({});
  const [remaps, setRemaps] = useState<Record<string, string>>({});
  const [reimportConfirmed, setReimportConfirmed] = useState<Record<string, boolean>>({});
  const [crossProviderConfirmed, setCrossProviderConfirmed] = useState<Record<string, boolean>>({});
  const [crossProviderModels, setCrossProviderModels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<CodexImportBusyState>(null);
  const [progress, setProgress] = useState<CodexImportProgress | null>(null);
  const operationAbortRef = useRef<AbortController | null>(null);
  const discovery = useCodexDiscovery({ filters, setSessions, setSelectedIds, setActiveId });
  const { loading, loadError, loadErrorCode, reload: reloadDiscovery } = discovery;

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [activeId, sessions],
  );

  /**
   * Refresh one authoritative row after a stale-state preflight or successful import.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const refreshSession = useCallback(async (threadId: string, signal?: AbortSignal) => {
    const updated = await fetchCodexImportDetail(threadId, signal);
    setSessions((current) => current.map((session) => session.id === threadId ? updated : session));
    setReimportConfirmed((current) => ({ ...current, [threadId]: false }));
  }, []);

  /**
   * Clear a stale signed preflight whenever its selection inputs change.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const invalidateRow = useCallback((threadId: string) => {
    setRowStates((current) => ({ ...current, [threadId]: { phase: "idle" } }));
  }, []);

  /**
   * Toggle one explicit row; no row is selected by default and no select-all action exists.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const toggleSelected = useCallback((session: CodexImportCandidateInfo) => {
    if (!session.importable || busy) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(session.id)) next.delete(session.id);
      else next.add(session.id);
      return next;
    });
    setActiveId(session.id);
    invalidateRow(session.id);
  }, [busy, invalidateRow]);

  /**
   * Store an explicit DirectoryPicker remap and invalidate the old plan.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const setRemap = useCallback((threadId: string, cwd: string) => {
    setRemaps((current) => ({ ...current, [threadId]: cwd }));
    invalidateRow(threadId);
  }, [invalidateRow]);

  /**
   * Store explicit source-change confirmation.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const setReimport = useCallback((threadId: string, confirmed: boolean) => {
    setReimportConfirmed((current) => ({ ...current, [threadId]: confirmed }));
    invalidateRow(threadId);
  }, [invalidateRow]);

  /**
   * Store explicit cross-provider history confirmation.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const setCrossProvider = useCallback((threadId: string, confirmed: boolean, model?: string) => {
    if (model) {
      setCrossProviderModels((current) => {
        const modelChanged = current[threadId] !== undefined && current[threadId] !== model;
        setCrossProviderConfirmed((confirmations) => ({
          ...confirmations,
          [threadId]: modelChanged ? false : confirmed,
        }));
        return { ...current, [threadId]: model };
      });
    } else {
      setCrossProviderConfirmed((current) => ({ ...current, [threadId]: confirmed }));
    }
    setRowStates((current) => ({
      ...current,
      [threadId]: {
        phase: "idle",
        crossProviderOptions: current[threadId]?.crossProviderOptions,
      },
    }));
  }, []);

  const preflightSelected = useCodexPreflightAction({
    busy,
    setBusy,
    setProgress,
    operationAbortRef,
    sessions,
    selectedIds,
    setRowStates,
    remaps,
    reimportConfirmed,
    crossProviderConfirmed,
    crossProviderModels,
    setCrossProviderModels,
    refreshSession,
  });

  const canImport = selectedIds.size > 0 && [...selectedIds].every((id) => (
    rowStates[id]?.phase === "ready" || rowStates[id]?.phase === "already"
  ));

  const importSelected = useCodexRunAction({
    busy,
    setBusy,
    setProgress,
    operationAbortRef,
    sessions,
    selectedIds,
    setRowStates,
    canImport,
    rowStates,
    remaps,
    setSessions,
    refreshSession,
  });

  /**
   * Abort the active browser request; the server propagates the signal to native summarization.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const cancelOperation = useCallback(() => {
    operationAbortRef.current?.abort();
  }, []);

  /**
   * Re-enumerate authoritative metadata without changing the explicit selection defaults.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  const reload = useCallback(() => {
    setReimportConfirmed({});
    setCrossProviderConfirmed({});
    setRowStates({});
    reloadDiscovery();
  }, [reloadDiscovery]);

  return {
    filters,
    setFilters,
    sessions,
    selectedIds,
    activeId,
    setActiveId,
    activeSession,
    rowStates,
    remaps,
    reimportConfirmed,
    crossProviderConfirmed,
    crossProviderModels,
    loading,
    loadError,
    loadErrorCode,
    busy,
    progress,
    canImport,
    toggleSelected,
    setRemap,
    setReimport,
    setCrossProvider,
    reload,
    cancelOperation,
    preflightSelected,
    importSelected,
  };
}
