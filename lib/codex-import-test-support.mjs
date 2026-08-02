import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an isolated Codex/Pi fixture root and register cleanup.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createCodexImportTestRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-codex-import-"));
  const codexHome = join(root, ".codex");
  const agentDir = join(root, ".pi-agent");
  const workspace = join(root, "workspace");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, codexHome, agentDir, workspace };
}

/**
 * Persist strict LF-delimited Codex JSONL.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function writeCodexRollout(filePath, records, trailingText = "") {
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n${trailingText}`);
}

/**
 * Build a minimal authority database with a deliberately old column set.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createThreadsDatabase(codexHome, rows, extraColumns = "") {
  const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      source TEXT,
      cwd TEXT,
      title TEXT,
      archived INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT 0
      ${extraColumns}
    )
  `);
  const statement = database.prepare(`
    INSERT INTO threads (id, rollout_path, source, cwd, title, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    statement.run(
      row.id,
      row.rolloutPath,
      row.source ?? "vscode",
      row.cwd ?? "",
      row.title ?? row.id,
      row.archived ? 1 : 0,
      row.createdAt ?? 1,
      row.updatedAt ?? 2,
    );
  }
  database.close();
}

/**
 * Build representative visible Codex records without private transcript text.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createVisibleCodexRecords(threadId, initialCwd, effectiveCwd, options = {}) {
  const source = options.source ?? "vscode";
  const records = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: initialCwd,
        source,
        thread_source: options.threadSource ?? "user",
      },
    },
    {
      timestamp: "2026-01-01T00:00:00.100Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", model_context_window: options.contextWindow ?? 128000 },
    },
    {
      timestamp: "2026-01-01T00:00:00.200Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "PRIVATE_DEVELOPER_CONTEXT" }],
      },
    },
    {
      timestamp: "2026-01-01T00:00:00.300Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "PRIVATE_CANONICAL_USER_CONTEXT" }],
      },
    },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: effectiveCwd,
        workspace_roots: options.workspaceRoots ?? [initialCwd],
        model: options.model ?? "gpt-5.4",
        effort: "high",
        sandbox_policy: { writable_roots: options.writableRoots ?? [effectiveCwd] },
      },
    },
    {
      timestamp: "2026-01-01T00:00:01.100Z",
      type: "event_msg",
      payload: { type: "user_message", message: options.userText ?? "VISIBLE_USER_REQUEST", images: [], local_images: [] },
    },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "VISIBLE_THINKING_SUMMARY" }],
        encrypted_content: "PRIVATE_REASONING_STATE",
      },
    },
    {
      timestamp: "2026-01-01T00:00:02.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "VISIBLE_ASSISTANT_PROGRESS", text_signature: "PRIVATE_TEXT_SIGNATURE" }],
        response_id: "PRIVATE_RESPONSE_ID",
      },
    },
    {
      timestamp: "2026-01-01T00:00:02.200Z",
      type: "response_item",
      payload: { type: "function_call", call_id: "call/one", name: "read", arguments: "{\"path\":\"marker.txt\"}" },
    },
    {
      timestamp: "2026-01-01T00:00:02.300Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call/one", output: "VISIBLE_TOOL_OUTPUT" },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "VISIBLE_FINAL_ANSWER" }],
      },
    },
    {
      timestamp: "2026-01-01T00:00:03.100Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" },
    },
  ];
  return records;
}
