"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCodexImport } from "@/hooks/useCodexImport";
import { useI18n } from "@/hooks/useI18n";
import { CodexImportCandidateList } from "./codex-import/CodexImportCandidateList";
import { CodexImportDetail } from "./codex-import/CodexImportDetail";
import { CodexImportFiltersPanel } from "./codex-import/CodexImportFilters";
import { DirectoryPicker } from "./DirectoryPicker";

interface Props {
  onClose: () => void;
  onImported: (sessionIds: string[]) => void;
}

/**
 * Render the formal selective Codex Desktop Session import workflow.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function CodexImportDialog({ onClose, onImported }: Props) {
  const { t } = useI18n();
  const state = useCodexImport();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [remapThreadId, setRemapThreadId] = useState<string | null>(null);

  useEffect(() => setPortalTarget(document.body), []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !state.busy && !remapThreadId) onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, remapThreadId, state.busy]);

  if (!portalTarget) return null;
  const activeId = state.activeSession?.id;
  const activeRowState = activeId ? state.rowStates[activeId] : undefined;
  const selectedCount = state.selectedIds.size;

  return createPortal(
    <div
      className="codex-import-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="codex-import-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !state.busy) onClose();
      }}
    >
      <div className="codex-import-dialog">
        <header className="codex-import-header">
          <div>
            <h2 id="codex-import-title">{t("codexImport.title")}</h2>
            <p>{t("codexImport.subtitle")}</p>
          </div>
          <div className="codex-import-header-actions">
            <button
              type="button"
              className="codex-import-refresh"
              disabled={Boolean(state.busy)}
              onClick={state.reload}
              aria-label={t("codexImport.refreshSource")}
              title={t("codexImport.refreshSource")}
            >
              ↻
            </button>
            <button
              type="button"
              className="codex-import-close"
              disabled={Boolean(state.busy)}
              onClick={onClose}
              aria-label={t("i18n.close")}
              title={t("i18n.close")}
            >
              ×
            </button>
          </div>
        </header>

        <CodexImportFiltersPanel
          filters={state.filters}
          setFilters={state.setFilters}
          disabled={Boolean(state.busy)}
        />

        {state.loadError && (
          <div className="codex-import-load-error" role="alert">
            {state.loadErrorCode
              ? t("codexImport.errorGeneric", { code: state.loadErrorCode })
              : state.loadError}
          </div>
        )}
        <div className="codex-import-content">
          <section className="codex-import-list-pane">
            <div className="codex-import-pane-title">
              <span>{t("codexImport.sessions")}</span>
              <span>{t("codexImport.foundCount", { count: state.sessions.length })}</span>
            </div>
            <CodexImportCandidateList
              sessions={state.sessions}
              selectedIds={state.selectedIds}
              activeId={state.activeId}
              rowStates={state.rowStates}
              loading={state.loading}
              disabled={Boolean(state.busy)}
              onActivate={state.setActiveId}
              onToggle={state.toggleSelected}
            />
          </section>
          <section className="codex-import-detail-pane">
            <CodexImportDetail
              session={state.activeSession}
              state={activeRowState}
              remap={activeId ? state.remaps[activeId] : undefined}
              reimportConfirmed={activeId ? state.reimportConfirmed[activeId] === true : false}
              crossProviderConfirmed={activeId ? state.crossProviderConfirmed[activeId] === true : false}
              crossProviderModel={activeId ? state.crossProviderModels[activeId] : undefined}
              disabled={Boolean(state.busy)}
              onPickRemap={() => activeId && setRemapThreadId(activeId)}
              onReimportChange={(confirmed) => activeId && state.setReimport(activeId, confirmed)}
              onCrossProviderChange={(confirmed, model) => (
                activeId && state.setCrossProvider(activeId, confirmed, model)
              )}
            />
          </section>
        </div>

        <footer className="codex-import-footer">
          <div>
            <strong>{t("codexImport.selectedCount", { count: selectedCount })}</strong>
            <span>
              {state.progress
                ? t("codexImport.progress", { current: state.progress.current, total: state.progress.total })
                : t("codexImport.noBulkDefault")}
            </span>
          </div>
          <div className="codex-import-footer-actions">
            {state.busy ? (
              <button type="button" onClick={state.cancelOperation}>{t("codexImport.cancelOperation")}</button>
            ) : (
              <button type="button" onClick={onClose}>{t("i18n.cancel")}</button>
            )}
            <button
              type="button"
              disabled={selectedCount === 0 || Boolean(state.busy)}
              onClick={() => void state.preflightSelected()}
            >
              {state.busy === "preflight" ? t("codexImport.preflighting") : t("codexImport.preflightSelected")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!state.canImport || Boolean(state.busy)}
              onClick={() => {
                void state.importSelected().then((results) => {
                  const importedIds = [...new Set(results.map((result) => result.sessionId))];
                  if (importedIds.length > 0) onImported(importedIds);
                });
              }}
            >
              {state.busy === "import" ? t("codexImport.importing") : t("codexImport.importSelected")}
            </button>
          </div>
        </footer>
      </div>

      {remapThreadId && (
        <DirectoryPicker
          onCancel={() => setRemapThreadId(null)}
          onSelect={(path) => {
            state.setRemap(remapThreadId, path);
            setRemapThreadId(null);
          }}
        />
      )}
    </div>,
    portalTarget,
  );
}
