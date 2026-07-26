/**
 * SchedulesPanel — Modal for managing recurring prompt schedules.
 *
 * Displays session-bound schedules with pause, edit, resume, and model controls.
 *
 * @author claude-sonnet-4-20250514, OpenAI Codex
 * @version 1.2.0
 */

"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface ScheduleEntry {
  id: string;
  intervalSeconds: number;
  prompt: string;
  nextFireAt: number;
  enabled: boolean;
  source: string;
  createdAt: number;
  lastFiredAt?: number;
  fireCount: number;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
  sessionId?: string;
}

interface SchedulesResponse {
  schedules?: ScheduleEntry[];
  error?: string;
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface SchedulesPanelProps {
  onClose: () => void;
  modelOptions?: ModelOption[];
  currentModel?: { provider: string; modelId: string } | null;
  currentThinkingLevel?: string;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  thinkingLevelsByModel?: Record<string, string[]>;
  thinkingLevelMapsByModel?: Record<string, Record<string, string | null>>;
  /** Session receiving schedules created in this panel. */
  sessionId?: string | null;
  /** Whether an unsaved chat can be promoted into a schedule session. */
  canCreateSession?: boolean;
  /** Create and select a dedicated session for the first schedule. */
  onEnsureSession?: () => Promise<string | null>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const INTERVAL_PRESETS = [
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
  { label: "10 minutes", seconds: 600 },
  { label: "15 minutes", seconds: 900 },
  { label: "30 minutes", seconds: 1800 },
  { label: "1 hour", seconds: 3600 },
  { label: "2 hours", seconds: 7200 },
  { label: "6 hours", seconds: 21600 },
  { label: "12 hours", seconds: 43200 },
  { label: "1 day", seconds: 86400 },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatCountdown(timestamp: number): string {
  const diff = timestamp - Date.now();
  if (diff <= 0) return "due now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

// ── Component ──────────────────────────────────────────────────────────────

export function SchedulesPanel({
  onClose,
  modelOptions,
  currentModel,
  currentThinkingLevel,
  availableThinkingLevels,
  thinkingLevelMap,
  thinkingLevelsByModel,
  thinkingLevelMapsByModel,
  sessionId,
  canCreateSession = false,
  onEnsureSession,
}: SchedulesPanelProps) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const [actionScheduleId, setActionScheduleId] = useState<string | null>(null);
  const [newInterval, setNewInterval] = useState(300);
  const [newPrompt, setNewPrompt] = useState("");
  const [newModel, setNewModel] = useState(currentModel?.modelId ?? "");
  const [newProvider, setNewProvider] = useState(currentModel?.provider ?? "");
  const [newThinkingLevel, setNewThinkingLevel] = useState(currentThinkingLevel ?? "auto");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // ── Fetch ─────────────────────────────────────────────────────────────

  const fetchSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as SchedulesResponse;
      if (data.error) throw new Error(data.error);
      setSchedules(data.schedules ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchSchedules(); }, [fetchSchedules, sessionId]);

  // ── Tick managed externally by useScheduleTicker hook ────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(timer);
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────

  const handleAdd = async () => {
    if (!newPrompt.trim()) { setAddError("Enter a prompt."); return; }
    setAdding(true);
    setAddError(null);
    try {
      const targetSessionId = sessionId ?? await onEnsureSession?.();
      if (!targetSessionId) {
        throw new Error("Select a workspace so a schedule session can be created.");
      }

      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intervalSeconds: newInterval,
          prompt: newPrompt.trim(),
          enabled: true,
          modelProvider: newProvider || undefined,
          modelId: newModel || undefined,
          thinkingLevel: newThinkingLevel !== "auto" ? newThinkingLevel : undefined,
          sessionId: targetSessionId,
        }),
      });
      const data = await res.json() as { schedule?: ScheduleEntry; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchSchedules();
      setShowAddForm(false);
      setEditingScheduleId(null);
      setNewPrompt("");
      setNewInterval(300);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  /** Bind a legacy schedule to the session currently open in pi-web.
   *
   * @author claude-sonnet-4-20250514
   */
  const handleBindToCurrentSession = async (id: string) => {
    if (!sessionId) return;
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, sessionId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSchedules();
    } catch (bindError) {
      setError(bindError instanceof Error ? bindError.message : String(bindError));
    }
  };

  const closeForm = () => {
    setShowAddForm(false);
    setEditingScheduleId(null);
    setAddError(null);
  };

  /** Open the shared form for a paused schedule. */
  const handleStartEdit = (schedule: ScheduleEntry) => {
    if (schedule.enabled) {
      setError("Pause the schedule before editing it.");
      return;
    }
    setError(null);
    setAddError(null);
    setEditingScheduleId(schedule.id);
    setNewInterval(schedule.intervalSeconds);
    setNewPrompt(schedule.prompt);
    setNewProvider(schedule.modelProvider ?? "");
    setNewModel(schedule.modelId ?? "");
    setNewThinkingLevel(schedule.thinkingLevel ?? "auto");
    setShowAddForm(true);
  };

  /** Save editable fields while preserving ownership and execution history. */
  const handleSaveEdit = async () => {
    if (!editingScheduleId) return;
    if (!newPrompt.trim()) { setAddError("Enter a prompt."); return; }
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingScheduleId,
          action: "update",
          intervalSeconds: newInterval,
          prompt: newPrompt.trim(),
          modelProvider: newProvider,
          modelId: newModel,
          thinkingLevel: newThinkingLevel,
        }),
      });
      const data = await res.json() as { schedule?: ScheduleEntry; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchSchedules();
      closeForm();
    } catch (editError) {
      setAddError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setAdding(false);
    }
  };

  /** Pause or resume without changing configuration or execution history. */
  const handleLifecycleAction = async (id: string, action: "pause" | "resume") => {
    setActionScheduleId(id);
    setError(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json() as { schedule?: ScheduleEntry; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      await fetchSchedules();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setActionScheduleId(null);
    }
  };

  /** Remove a schedule. */
  const handleDelete = async (id: string) => {
    setActionScheduleId(id);
    setError(null);
    try {
      const res = await fetch(`/api/schedules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json() as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (editingScheduleId === id) closeForm();
      await fetchSchedules();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setActionScheduleId(null);
    }
  };

  // ── Render helpers ────────────────────────────────────────────────────

  const visibleSchedules = schedules.filter((schedule) =>
    schedule.sessionId === sessionId || schedule.sessionId === undefined,
  );
  const activeCount = visibleSchedules.filter((schedule) => schedule.enabled).length;
  const addDisabled = schedules.length >= 50 || (!sessionId && !canCreateSession);

  const selectedModelKey = newProvider && newModel ? `${newProvider}:${newModel}` : undefined;
  const selectedThinkingLevels = selectedModelKey
    ? thinkingLevelsByModel?.[selectedModelKey] ?? availableThinkingLevels
    : availableThinkingLevels;
  const selectedThinkingLevelMap = selectedModelKey
    ? thinkingLevelMapsByModel?.[selectedModelKey] ?? thinkingLevelMap
    : thinkingLevelMap;
  const filteredThinkingLevels = THINKING_LEVELS.filter((level) => {
    if (!selectedThinkingLevels) return true;
    return level === "auto" || selectedThinkingLevels.includes(level);
  });

  const thinkingDisplayLabel = (level: string) => {
    if (level === "auto" || !selectedThinkingLevelMap) return level;
    return selectedThinkingLevelMap[level] ?? level;
  };

  useEffect(() => {
    if (newThinkingLevel !== "auto" && selectedThinkingLevels && !selectedThinkingLevels.includes(newThinkingLevel)) {
      setNewThinkingLevel("auto");
    }
  }, [newThinkingLevel, selectedThinkingLevels]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div style={{
      background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10,
      boxShadow: "0 12px 36px rgba(0,0,0,0.16)", width: 520,
      maxHeight: "min(600px, 65vh)", display: "flex", flexDirection: "column", overflow: "hidden",
      animation: "schedules-panel-in 0.18s ease-out",
    }}>
      <style>{`@keyframes schedules-panel-in { from { opacity:0; transform:translateY(-8px) scale(.97); } to { opacity:1; transform:translateY(0) scale(1); } }`}</style>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Schedules</span>
          {!loading && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{activeCount}/{visibleSchedules.length} active</span>}
        </div>
        <button onClick={onClose} title="Close" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
        {error && <div style={{ margin: "4px 0", padding: "6px 10px", borderRadius: 6, fontSize: 12, background: "rgba(220,38,38,0.08)", color: "#dc2626" }}>{error}</div>}
        {loading && <div style={{ padding: "20px", textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>Loading...</div>}
        {!loading && !error && visibleSchedules.length === 0 && !showAddForm && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ marginBottom: 8 }}><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></div>
            No schedules configured.<br />Create one to automatically run prompts.
          </div>
        )}

        {visibleSchedules.map((schedule) => {
          const actionPending = actionScheduleId === schedule.id;
          const actionButtonStyle = {
            flexShrink: 0,
            padding: "3px 7px",
            background: "none",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text-muted)",
            cursor: actionPending ? "wait" : "pointer",
            fontSize: 10,
            opacity: actionPending ? 0.5 : 1,
          } as const;

          return (
            <div key={schedule.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderRadius: 7, border: "1px solid var(--border)", marginBottom: 6, opacity: schedule.enabled ? 1 : 0.72 }}>
              <span style={{ flexShrink: 0, fontSize: 13, color: schedule.enabled ? "var(--accent)" : "var(--text-dim)" }}>{schedule.enabled ? "▶" : "⏸"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>{schedule.prompt}</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <span>Every {formatInterval(schedule.intervalSeconds)}</span>
                  {schedule.enabled
                    ? <span>{formatCountdown(schedule.nextFireAt)}</span>
                    : <span style={{ color: "#d97706" }}>Paused</span>}
                  {schedule.fireCount > 0 && <span>Fired {schedule.fireCount}×</span>}
                  {schedule.modelId && <span style={{ color: "var(--accent)", fontSize: 10 }}>{schedule.modelId}</span>}
                  {schedule.thinkingLevel && schedule.thinkingLevel !== "auto" && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>🧠{schedule.thinkingLevel}</span>}
                  {!schedule.sessionId && <span style={{ fontSize: 10, color: "#d97706" }}>unbound</span>}
                </div>
              </div>
              {!schedule.sessionId && sessionId && (
                <button type="button" onClick={() => void handleBindToCurrentSession(schedule.id)} title="Bind this schedule to the current session" style={{ ...actionButtonStyle, borderColor: "var(--accent)", color: "var(--accent)" }}>
                  Bind here
                </button>
              )}
              {schedule.enabled ? (
                <button type="button" onClick={() => void handleLifecycleAction(schedule.id, "pause")} disabled={actionPending} title="Pause schedule" style={actionButtonStyle}>
                  {actionPending ? "..." : "Pause"}
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => handleStartEdit(schedule)} disabled={actionPending} title="Edit paused schedule" style={actionButtonStyle}>
                    Edit
                  </button>
                  <button type="button" onClick={() => void handleLifecycleAction(schedule.id, "resume")} disabled={actionPending} title="Resume from a fresh interval" style={{ ...actionButtonStyle, borderColor: "var(--accent)", color: "var(--accent)" }}>
                    {actionPending ? "..." : "Resume"}
                  </button>
                </>
              )}
              <button type="button" onClick={() => void handleDelete(schedule.id)} disabled={actionPending} title="Delete schedule" style={{ flexShrink: 0, width: 26, height: 26, padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-dim)", cursor: actionPending ? "wait" : "pointer", opacity: actionPending ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          );
        })}
      </div>

      {/* Add/edit form */}
      {showAddForm && (
        <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
            {editingScheduleId ? "Edit paused schedule" : "New schedule"}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>
            {editingScheduleId
              ? "Saving keeps this schedule paused. Resume it when ready."
              : sessionId ? "The schedule starts immediately after creation." : "A dedicated schedule session will be created automatically."}
          </div>
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>Interval</label>
            <select value={newInterval} onChange={(e) => setNewInterval(Number(e.target.value))}
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}>
              {!INTERVAL_PRESETS.some((preset) => preset.seconds === newInterval) && (
                <option value={newInterval}>{formatInterval(newInterval)} (current)</option>
              )}
              {INTERVAL_PRESETS.map((preset) => <option key={preset.seconds} value={preset.seconds}>{preset.label}</option>)}
            </select>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>Prompt</label>
            <input type="text" value={newPrompt} onChange={(e) => { setNewPrompt(e.target.value); setAddError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !adding) {
                  void (editingScheduleId ? handleSaveEdit() : handleAdd());
                }
                if (e.key === "Escape") closeForm();
              }}
              placeholder="e.g., Check server health..." autoFocus
              style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: `1px solid ${addError ? "#dc2626" : "var(--border)"}`, background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none", boxSizing: "border-box" }} />
            {addError && <div style={{ fontSize: 11, color: "#dc2626", marginTop: 3 }}>{addError}</div>}
          </div>

          {/* Model + Thinking row */}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {/* Model selector */}
            {modelOptions && modelOptions.length > 0 && (
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>Model</label>
                <select
                  value={newProvider && newModel ? JSON.stringify([newProvider, newModel]) : ""}
                  onChange={(e) => {
                    if (!e.target.value) {
                      setNewProvider("");
                      setNewModel("");
                      return;
                    }
                    const [provider, modelId] = JSON.parse(e.target.value) as [string, string];
                    setNewProvider(provider);
                    setNewModel(modelId);
                  }}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}>
                  <option value="">Default</option>
                  {modelOptions.map((m) => (
                    <option key={`${m.provider}/${m.modelId}`} value={JSON.stringify([m.provider, m.modelId])}>{m.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Thinking level */}
            <div style={{ width: 110 }}>
              <label style={{ display: "block", fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>Thinking</label>
              <select value={newThinkingLevel} onChange={(e) => setNewThinkingLevel(e.target.value)}
                style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none" }}>
                {filteredThinkingLevels.map((lvl) => (
                  <option key={lvl} value={lvl}>{thinkingDisplayLabel(lvl)}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={closeForm}
              style={{ padding: "4px 12px", borderRadius: 5, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}>Cancel</button>
            <button type="button" onClick={() => void (editingScheduleId ? handleSaveEdit() : handleAdd())} disabled={adding || !newPrompt.trim()}
              style={{ padding: "4px 14px", borderRadius: 5, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: 12, fontWeight: 500, cursor: adding || !newPrompt.trim() ? "not-allowed" : "pointer", opacity: adding || !newPrompt.trim() ? 0.5 : 1 }}>
              {adding ? (editingScheduleId ? "Saving..." : "Adding...") : editingScheduleId ? "Save Changes" : "Add Schedule"}
            </button>
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
        {!showAddForm && (
          <button type="button" onClick={() => {
            setEditingScheduleId(null);
            setNewPrompt("");
            setNewInterval(300);
            setNewModel(currentModel?.modelId ?? "");
            setNewProvider(currentModel?.provider ?? "");
            setNewThinkingLevel(currentThinkingLevel ?? "auto");
            setAddError(null);
            setShowAddForm(true);
          }} disabled={addDisabled}
            title={schedules.length >= 50 ? "Max 50 schedules" : addDisabled ? "Select a workspace first" : "Add schedule"}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "none", color: "var(--text-muted)", fontSize: 12, cursor: addDisabled ? "not-allowed" : "pointer", opacity: addDisabled ? 0.4 : 1, flex: 1, justifyContent: "center" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            New Schedule
          </button>
        )}
        <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
          Tip: <code style={{ background: "var(--bg-hover)", padding: "1px 5px", borderRadius: 3, fontFamily: "var(--font-mono)", fontSize: 10 }}>/cron-add 5m check</code>
        </span>
      </div>
    </div>
  );
}
