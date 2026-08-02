import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createCodexImportTestRoot,
  createThreadsDatabase,
  createVisibleCodexRecords,
  writeCodexRollout,
} from "./codex-import-test-support.mjs";

const jiti = createJiti(import.meta.url);
const {
  CodexImportError,
  classifyCodexThreadSource,
  createStableRolloutSnapshot,
  getCodexCandidateById,
  inspectCodexRollout,
  listCodexCandidates,
  readStrictCodexJsonl,
  resolveCodexImportCwd,
  verifyRolloutSnapshot,
} = await jiti.import("./codex-import/index.ts");

test("classifies root, subagent, guardian, and conflicting source signals without title guessing", () => {
  assert.equal(classifyCodexThreadSource({ source: "vscode", threadSource: "user" }), "root");
  assert.equal(classifyCodexThreadSource({
    source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "parent" } } }),
    threadSource: "subagent",
  }), "subagent");
  assert.equal(classifyCodexThreadSource({
    source: JSON.stringify({ subagent: { other: "guardian" } }),
    threadSource: "subagent",
  }), "guardian");
  assert.equal(classifyCodexThreadSource({ source: "vscode", threadSource: "subagent" }), "subagent");
  assert.equal(classifyCodexThreadSource({ source: "{malformed", threadSource: null }), "unknown");
});

test("detects SQLite capabilities and filters by name, workspace, sandbox root, and latest cwd", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const firstId = "01900000-0000-7000-8000-000000000001";
  const secondId = "01900000-0000-7000-8000-000000000002";
  const subagentId = "01900000-0000-7000-8000-000000000009";
  const firstRollout = join(fixture.codexHome, "sessions", "first.jsonl");
  const secondRollout = join(fixture.codexHome, "archived_sessions", "second.jsonl");
  const subagentRollout = join(fixture.codexHome, "sessions", "subagent.jsonl");
  const latestCwd = join(fixture.root, "latest-cwd");
  const secondCwd = join(fixture.root, "second-cwd");
  const sandboxRoot = join(fixture.root, "sandbox-root");
  mkdirSync(latestCwd);
  mkdirSync(secondCwd);
  mkdirSync(sandboxRoot);

  const firstRecords = createVisibleCodexRecords(firstId, fixture.workspace, latestCwd, {
    workspaceRoots: [fixture.workspace],
    writableRoots: [sandboxRoot],
  });
  firstRecords.unshift({
    timestamp: "2025-12-31T00:00:00.000Z",
    type: "session_meta",
    payload: { id: "different-thread", session_id: "different-thread", cwd: fixture.root, source: "vscode" },
  });
  writeCodexRollout(firstRollout, firstRecords);
  writeCodexRollout(secondRollout, createVisibleCodexRecords(secondId, secondCwd, secondCwd));
  const subagentSource = JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: firstId } } });
  writeCodexRollout(subagentRollout, createVisibleCodexRecords(
    subagentId,
    fixture.workspace,
    fixture.workspace,
    { source: JSON.parse(subagentSource), threadSource: "subagent" },
  ));
  createThreadsDatabase(fixture.codexHome, [
    { id: firstId, rolloutPath: firstRollout, cwd: fixture.workspace, title: "Named Alpha" },
    { id: secondId, rolloutPath: secondRollout, cwd: secondCwd, title: "Archived Beta", archived: true },
    { id: subagentId, rolloutPath: subagentRollout, cwd: fixture.workspace, title: "Internal Child", source: subagentSource },
  ]);

  const defaults = await listCodexCandidates({ codexHome: fixture.codexHome, agentDir: fixture.agentDir });
  assert.deepEqual(defaults.map((candidate) => candidate.id), [firstId]);
  assert.equal(defaults[0].effectiveCwd, latestCwd);
  assert.deepEqual(defaults[0].workspaceRoots, [fixture.workspace]);
  assert.deepEqual(defaults[0].sandboxWritableRoots, [sandboxRoot]);

  const byName = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { name: "alpha" },
  });
  assert.deepEqual(byName.map((candidate) => candidate.id), [firstId]);

  const byWorkspace = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { workspace: fixture.workspace },
  });
  assert.deepEqual(byWorkspace.map((candidate) => candidate.id), [firstId]);
  const byWorkspaceFragment = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { workspace: "workspace" },
  });
  assert.deepEqual(byWorkspaceFragment.map((candidate) => candidate.id), [firstId]);

  const bySandbox = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { sandbox: sandboxRoot },
  });
  assert.deepEqual(bySandbox.map((candidate) => candidate.id), [firstId]);

  const byCwd = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { cwd: latestCwd },
  });
  assert.deepEqual(byCwd.map((candidate) => candidate.id), [firstId]);

  const archived = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { includeArchived: true },
  });
  assert.deepEqual(new Set(archived.map((candidate) => candidate.id)), new Set([firstId, secondId]));

  const withSubagents = await listCodexCandidates({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    filters: { includeSubagents: true },
  });
  assert.deepEqual(new Set(withSubagents.map((candidate) => candidate.id)), new Set([firstId, subagentId]));
});

test("isolates one damaged rollout and resolves details by exact SQLite ID", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const validId = "01900000-0000-7000-8000-00000000002a";
  const badId = "01900000-0000-7000-8000-00000000002b";
  const validPath = join(fixture.codexHome, "sessions", "valid.jsonl");
  const badPath = join(fixture.codexHome, "sessions", "bad.jsonl");
  writeCodexRollout(validPath, createVisibleCodexRecords(validId, fixture.workspace, fixture.workspace));
  writeFileSync(badPath, "{damaged rollout\n");
  createThreadsDatabase(fixture.codexHome, [
    { id: badId, rolloutPath: badPath, cwd: fixture.workspace, title: "Bad" },
    { id: validId, rolloutPath: validPath, cwd: fixture.workspace, title: "Valid" },
  ]);

  const listed = await listCodexCandidates({ codexHome: fixture.codexHome, agentDir: fixture.agentDir });
  assert.deepEqual(listed.map((candidate) => candidate.id), [validId]);
  const detail = await getCodexCandidateById({
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    threadId: validId,
  });
  assert.equal(detail.id, validId);
});

test("uses the matching session_meta when a rollout contains multiple headers", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000003";
  const rolloutPath = join(fixture.codexHome, "sessions", "multiple-meta.jsonl");
  const records = createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace);
  records.unshift({
    timestamp: "2025-01-01T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "01900000-0000-7000-8000-999999999999",
      session_id: "01900000-0000-7000-8000-999999999999",
      cwd: fixture.root,
      source: { subagent: { other: "guardian" } },
    },
  });
  writeCodexRollout(rolloutPath, records);

  const inspection = await inspectCodexRollout({
    threadId,
    rolloutPath,
    sqliteSource: "vscode",
    sqliteThreadSource: "user",
  });
  assert.equal(inspection.sourceKind, "root");
  assert.equal(inspection.initialCwd, fixture.workspace);
  assert.equal(inspection.matchingSessionMetaCount, 1);
});

test("strict JSONL parsing rejects malformed middle and final records", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const middle = join(fixture.codexHome, "sessions", "middle.jsonl");
  const final = join(fixture.codexHome, "sessions", "final.jsonl");
  writeFileSync(middle, `${JSON.stringify({ type: "session_meta", payload: { id: "x" } })}\n{broken}\n{}\n`);
  writeFileSync(final, `${JSON.stringify({ type: "session_meta", payload: { id: "x" } })}\n{\"type\":`);

  await assert.rejects(
    async () => {
      for await (const record of readStrictCodexJsonl(middle)) {
        void record;
      }
    },
    (error) => error instanceof CodexImportError && error.code === "MALFORMED_JSONL",
  );
  await assert.rejects(
    async () => {
      for await (const record of readStrictCodexJsonl(final)) {
        void record;
      }
    },
    (error) => error instanceof CodexImportError && error.code === "MALFORMED_JSONL",
  );
});

test("requires an explicit existing directory remap and never treats sandbox roots as cwd", (t) => {
  const fixture = createCodexImportTestRoot(t);
  const missing = join(fixture.root, "removed-source-cwd");
  const remap = join(fixture.root, "explicit-remap");
  mkdirSync(remap);

  assert.throws(
    () => resolveCodexImportCwd(missing),
    (error) => error instanceof CodexImportError && error.code === "CWD_REMAP_REQUIRED",
  );
  assert.equal(resolveCodexImportCwd(missing, remap), remap);
});

test("snapshot is fixed-length, detects tampering, and notices a concurrent source append", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000004";
  const rolloutPath = join(fixture.codexHome, "sessions", "snapshot.jsonl");
  writeCodexRollout(rolloutPath, createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace));

  const snapshot = await createStableRolloutSnapshot({
    sourcePath: rolloutPath,
    codexHome: fixture.codexHome,
    agentDir: fixture.agentDir,
    threadId,
  });
  appendFileSync(snapshot.path, "tamper");
  await assert.rejects(
    () => inspectCodexRollout({
      threadId,
      rolloutPath: snapshot.path,
      sqliteSource: "vscode",
      sqliteThreadSource: "user",
      expectedSnapshotHash: snapshot.hash,
      expectedSnapshotSize: snapshot.size,
    }),
    (error) => error instanceof CodexImportError && error.code === "SNAPSHOT_CHANGED",
  );
  await assert.rejects(
    () => verifyRolloutSnapshot(snapshot),
    (error) => error instanceof CodexImportError && error.code === "SNAPSHOT_CHANGED",
  );

  let appended = false;
  await assert.rejects(
    () => createStableRolloutSnapshot({
      sourcePath: rolloutPath,
      codexHome: fixture.codexHome,
      agentDir: fixture.agentDir,
      threadId,
      onSourceChunk: () => {
        if (appended) return;
        appended = true;
        appendFileSync(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })}\n`);
      },
      maxAttempts: 1,
    }),
    (error) => error instanceof CodexImportError && error.code === "SOURCE_CHANGED",
  );
});

test("rejects rollout and staging paths that cross a symbolic link or Junction", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const external = join(fixture.root, "external");
  const linked = join(fixture.codexHome, "sessions", "linked");
  mkdirSync(external);
  symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
  const rolloutPath = join(linked, "escape.jsonl");
  writeCodexRollout(join(external, "escape.jsonl"), createVisibleCodexRecords("escape", fixture.workspace, fixture.workspace));

  await assert.rejects(
    () => createStableRolloutSnapshot({
      sourcePath: rolloutPath,
      codexHome: fixture.codexHome,
      agentDir: fixture.agentDir,
      threadId: "escape",
    }),
    (error) => error instanceof CodexImportError && ["LINKED_PATH_REJECTED", "SOURCE_PATH_REJECTED"].includes(error.code),
  );
});
