"use client";

import type { CodexImportCandidateInfo, CodexImportWarningInfo } from "@/lib/api-types";
import type { CodexImportRowState } from "@/hooks/useCodexImport";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  session: CodexImportCandidateInfo | null;
  state?: CodexImportRowState;
  remap?: string;
  reimportConfirmed: boolean;
  crossProviderConfirmed: boolean;
  crossProviderModel?: string;
  disabled: boolean;
  onPickRemap: () => void;
  onReimportChange: (confirmed: boolean) => void;
  onCrossProviderChange: (confirmed: boolean, model?: string) => void;
}

/**
 * Render a labeled metadata value with path-safe wrapping.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function DetailValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="codex-import-detail-value">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

/**
 * Render a list of source paths without changing their meaning.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function PathList({ paths, empty }: { paths: string[]; empty: string }) {
  if (paths.length === 0) return <span className="codex-import-muted">{empty}</span>;
  return (
    <ul className="codex-import-path-list">
      {paths.map((path) => <li key={path} title={path}>{path}</li>)}
    </ul>
  );
}

/**
 * Render the lossy import-time compaction estimate.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function CompactionPlan({ state }: { state?: CodexImportRowState }) {
  const { t } = useI18n();
  const plan = state?.preflight?.compaction;
  if (!plan) return null;
  return (
    <section className="codex-import-plan">
      <h4>{t("codexImport.compactionPlan")}</h4>
      <div className="codex-import-plan-grid">
        <DetailValue label={t("codexImport.originalTokens")}>{plan.originalTokens.toLocaleString()}</DetailValue>
        <DetailValue label={t("codexImport.keptTokens")}>{plan.keptTokens.toLocaleString()}</DetailValue>
        <DetailValue label={t("codexImport.planChunks")}>{plan.estimatedChunks}</DetailValue>
        <DetailValue label={t("codexImport.planLayers")}>{plan.estimatedLayers}</DetailValue>
        <DetailValue label={t("codexImport.planCalls")}>{plan.estimatedCalls}</DetailValue>
        <DetailValue label={t("codexImport.compactionModel")}>
          {plan.compressionModel.provider}/{plan.compressionModel.modelId}
        </DetailValue>
      </div>
      {plan.lossy ? (
        <p className="codex-import-warning-text">{t("codexImport.lossyWarning")}</p>
      ) : (
        <p className="codex-import-ok-text">{t("codexImport.noCompactionNeeded")}</p>
      )}
      {plan.crossProvider && <p className="codex-import-warning-text">{t("codexImport.crossProviderPlan")}</p>}
    </section>
  );
}

/**
 * Render warnings from discovery, preflight, and publication without duplicates.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function ImportWarnings({ warnings }: { warnings: CodexImportWarningInfo[] }) {
  const { t } = useI18n();
  const unique = [...new Map(warnings.map((warning) => [warning.code, warning])).values()];
  if (unique.length === 0) return null;
  const translatedCodes = new Set([
    "MISSING_CWD",
    "CWD_REMAP_REQUIRED",
    "UNKNOWN_SOURCE_KIND",
    "IMAGE_OMITTED",
    "SYNTHETIC_TOOL_RESULT",
    "LATE_TOOL_OUTPUT",
    "ORPHAN_TOOL_OUTPUT",
    "CODEX_COMPACTION_BOUNDARY",
    "LOSSY_COMPACTION",
  ]);
  return (
    <section className="codex-import-risks">
      <h4>{t("codexImport.risks")}</h4>
      <ul>
        {unique.map((warning) => (
          <li key={warning.code}>
            {translatedCodes.has(warning.code)
              ? t(`codexImport.warning.${warning.code}`, { count: warning.count ?? 1 })
              : `${warning.code}: ${warning.message}`}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Render localized known failures while retaining a safe server message for unknown codes.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function ImportError({ state }: { state?: CodexImportRowState }) {
  const { t } = useI18n();
  if (!state?.error) return null;
  const translatedCodes = new Set([
    "CWD_REMAP_REQUIRED",
    "SOURCE_CHANGED_CONFIRMATION_REQUIRED",
    "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
    "LONG_CONTEXT_MODEL_UNAVAILABLE",
    "SOURCE_CHANGED",
    "PREFLIGHT_PLAN_CHANGED",
    "PREFLIGHT_TOKEN_EXPIRED",
    "COMPACTION_RUNTIME_CAPACITY_EXCEEDED",
    "COMPACTION_CRITICAL_CONTEXT_TOO_LARGE",
    "SEMANTIC_SUMMARY_TOO_LARGE",
    "SEMANTIC_SUMMARY_INCOMPLETE",
    "CODEX_SESSION_NOT_FOUND",
    "NO_VISIBLE_USER_MESSAGE",
  ]);
  const message = state.errorCode
    ? translatedCodes.has(state.errorCode)
      ? t(`codexImport.error.${state.errorCode}`)
      : t("codexImport.errorGeneric", { code: state.errorCode })
    : state.error;
  return <div className="codex-import-error" role="alert">{message}</div>;
}

/**
 * Render selected-session details, blocking risks, and explicit confirmations.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function CodexImportDetail({
  session,
  state,
  remap,
  reimportConfirmed,
  crossProviderConfirmed,
  crossProviderModel,
  disabled,
  onPickRemap,
  onReimportChange,
  onCrossProviderChange,
}: Props) {
  const { t } = useI18n();
  if (!session) return <div className="codex-import-empty">{t("codexImport.selectForDetails")}</div>;
  const crossOptions = state?.crossProviderOptions ?? [];
  const warnings = [
    ...session.warnings,
    ...(state?.preflight?.warnings ?? []),
    ...(state?.result?.warnings ?? []),
  ];

  return (
    <div className="codex-import-detail">
      <header>
        <h3>{session.name}</h3>
        <span className="codex-import-id">{session.id}</span>
      </header>

      <div className="codex-import-detail-grid">
        <DetailValue label={t("codexImport.latestCwd")}>{session.effectiveCwd || t("codexImport.noCwd")}</DetailValue>
        <DetailValue label={t("codexImport.targetCwd")}>{remap || session.effectiveCwd || t("codexImport.remapRequired")}</DetailValue>
        <DetailValue label={t("codexImport.workspaceRoots")}>
          <PathList paths={session.workspaceRoots} empty={t("codexImport.noneRecorded")} />
        </DetailValue>
        <DetailValue label={t("codexImport.sandboxRoots")}>
          <PathList paths={session.sandboxWritableRoots} empty={t("codexImport.noneRecorded")} />
        </DetailValue>
        <DetailValue label={t("codexImport.sourceStats")}>
          {t("codexImport.sourceStatsValue", {
            users: session.visibleUserCount,
            assistants: session.assistantCount,
            tools: session.toolCallCount,
          })}
        </DetailValue>
        <DetailValue label={t("codexImport.tokenEstimate")}>{session.estimatedTokens.toLocaleString()}</DetailValue>
      </div>

      {!session.cwdExists && !remap && (
        <div className="codex-import-blocker">
          <strong>{t("codexImport.missingCwdTitle")}</strong>
          <p>{t("codexImport.missingCwdBody")}</p>
          <button type="button" disabled={disabled} onClick={onPickRemap}>{t("codexImport.chooseRemap")}</button>
        </div>
      )}
      {remap && (
        <div className="codex-import-remap">
          <span>{t("codexImport.remappedTo", { path: remap })}</span>
          <button type="button" disabled={disabled} onClick={onPickRemap}>{t("codexImport.changeRemap")}</button>
        </div>
      )}

      {session.importState === "source_changed" && (
        <label className="codex-import-confirmation warning">
          <input
            type="checkbox"
            checked={reimportConfirmed}
            disabled={disabled}
            onChange={(event) => onReimportChange(event.target.checked)}
          />
          <span>{t("codexImport.confirmChangedSource")}</span>
        </label>
      )}

      {crossOptions.length > 0 && (
        <div className="codex-import-cross-provider">
          <label>
            <span>{t("codexImport.crossProviderModel")}</span>
            <select
              value={crossProviderModel ?? crossOptions[0]}
              disabled={disabled}
              onChange={(event) => onCrossProviderChange(false, event.target.value)}
            >
              {crossOptions.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
          </label>
          <label className="codex-import-confirmation warning">
            <input
              type="checkbox"
              checked={crossProviderConfirmed}
              disabled={disabled}
              onChange={(event) => onCrossProviderChange(event.target.checked, crossProviderModel ?? crossOptions[0])}
            />
            <span>{t("codexImport.confirmCrossProvider")}</span>
          </label>
        </div>
      )}

      <ImportWarnings warnings={warnings} />
      <ImportError state={state} />
      <CompactionPlan state={state} />
    </div>
  );
}
