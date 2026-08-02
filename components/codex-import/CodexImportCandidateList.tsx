"use client";

import type { CodexImportCandidateInfo } from "@/lib/api-types";
import type { CodexImportRowState } from "@/hooks/useCodexImport";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  sessions: CodexImportCandidateInfo[];
  selectedIds: Set<string>;
  activeId: string | null;
  rowStates: Record<string, CodexImportRowState>;
  loading: boolean;
  disabled: boolean;
  onActivate: (threadId: string) => void;
  onToggle: (session: CodexImportCandidateInfo) => void;
}

/**
 * Translate one import progress phase into a compact row label.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function PhaseBadge({ state }: { state?: CodexImportRowState }) {
  const { t } = useI18n();
  if (!state || state.phase === "idle") return null;
  const key = `codexImport.phase.${state.phase}`;
  return <span className={`codex-import-badge phase-${state.phase}`}>{t(key)}</span>;
}

/**
 * Render source and risk states without exposing transcript content.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function CandidateBadges({ session, state }: { session: CodexImportCandidateInfo; state?: CodexImportRowState }) {
  const { t } = useI18n();
  return (
    <div className="codex-import-row-badges">
      {session.importState === "already_imported" && (
        <span className="codex-import-badge status-ok">{t("codexImport.alreadyImported")}</span>
      )}
      {session.importState === "source_changed" && (
        <span className="codex-import-badge status-warning">{t("codexImport.sourceChanged")}</span>
      )}
      {session.archived && <span className="codex-import-badge">{t("codexImport.archived")}</span>}
      {session.sourceKind !== "root" && (
        <span className="codex-import-badge status-blocked">
          {t(`codexImport.sourceKind.${session.sourceKind}`)}
        </span>
      )}
      {session.codexCompactionCount > 0 && (
        <span className="codex-import-badge status-warning">{t("codexImport.codexCompacted")}</span>
      )}
      {!session.cwdExists && (
        <span className="codex-import-badge status-blocked">{t("codexImport.remapRequired")}</span>
      )}
      <PhaseBadge state={state} />
    </div>
  );
}

/**
 * Render explicitly selectable candidates; there is intentionally no select-all control.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function CodexImportCandidateList({
  sessions,
  selectedIds,
  activeId,
  rowStates,
  loading,
  disabled,
  onActivate,
  onToggle,
}: Props) {
  const { t } = useI18n();
  if (loading && sessions.length === 0) {
    return <div className="codex-import-empty">{t("codexImport.loading")}</div>;
  }
  if (sessions.length === 0) {
    return <div className="codex-import-empty">{t("codexImport.noSessions")}</div>;
  }

  return (
    <div className="codex-import-list" role="listbox" aria-label={t("codexImport.sessionsLabel")}>
      {sessions.map((session) => {
        const selected = selectedIds.has(session.id);
        const active = activeId === session.id;
        return (
          <div
            key={session.id}
            className={`codex-import-row${active ? " active" : ""}${selected ? " selected" : ""}`}
            role="option"
            aria-selected={active}
            onClick={() => onActivate(session.id)}
          >
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled || !session.importable}
              aria-label={t("codexImport.selectSession", { name: session.name })}
              onClick={(event) => event.stopPropagation()}
              onChange={() => onToggle(session)}
            />
            <div className="codex-import-row-main">
              <div className="codex-import-row-title" title={session.name}>{session.name}</div>
              <div className="codex-import-row-path" title={session.effectiveCwd || session.initialCwd}>
                {session.effectiveCwd || session.initialCwd || t("codexImport.noCwd")}
              </div>
              <CandidateBadges session={session} state={rowStates[session.id]} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
