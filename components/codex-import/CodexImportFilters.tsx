"use client";

import type { Dispatch, SetStateAction } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { CodexImportFilters } from "@/lib/codex-import-client";

interface Props {
  filters: CodexImportFilters;
  setFilters: Dispatch<SetStateAction<CodexImportFilters>>;
  disabled: boolean;
}

/**
 * Render one text filter while preserving the other independent filters.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function FilterInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="codex-import-filter-field">
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}

/**
 * Render candidate metadata filters and opt-in archive/internal-thread switches.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function CodexImportFiltersPanel({ filters, setFilters, disabled }: Props) {
  const { t } = useI18n();
  const updateText = (key: "name" | "workspace" | "sandbox" | "cwd", value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };
  const updateFlag = (
    key: "includeArchived" | "includeSubagents" | "includeGuardians",
    value: boolean,
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="codex-import-filters">
      <div className="codex-import-filter-grid">
        <FilterInput
          label={t("codexImport.filterName")}
          value={filters.name}
          placeholder={t("codexImport.filterNamePlaceholder")}
          disabled={disabled}
          onChange={(value) => updateText("name", value)}
        />
        <FilterInput
          label={t("codexImport.filterWorkspace")}
          value={filters.workspace}
          placeholder={t("codexImport.filterPathPlaceholder")}
          disabled={disabled}
          onChange={(value) => updateText("workspace", value)}
        />
        <FilterInput
          label={t("codexImport.filterSandbox")}
          value={filters.sandbox}
          placeholder={t("codexImport.filterPathPlaceholder")}
          disabled={disabled}
          onChange={(value) => updateText("sandbox", value)}
        />
        <FilterInput
          label={t("codexImport.filterCwd")}
          value={filters.cwd}
          placeholder={t("codexImport.filterPathPlaceholder")}
          disabled={disabled}
          onChange={(value) => updateText("cwd", value)}
        />
      </div>
      <div className="codex-import-filter-switches">
        <label>
          <input
            type="checkbox"
            checked={filters.includeArchived}
            disabled={disabled}
            onChange={(event) => updateFlag("includeArchived", event.target.checked)}
          />
          {t("codexImport.showArchived")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.includeSubagents}
            disabled={disabled}
            onChange={(event) => updateFlag("includeSubagents", event.target.checked)}
          />
          {t("codexImport.showSubagents")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={filters.includeGuardians}
            disabled={disabled}
            onChange={(event) => updateFlag("includeGuardians", event.target.checked)}
          />
          {t("codexImport.showGuardians")}
        </label>
      </div>
    </div>
  );
}
