import assert from "node:assert/strict";
import { mkdirSync, readdirSync, symlinkSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import {
  createCodexImportTestRoot,
  createVisibleCodexRecords,
  writeCodexRollout,
} from "./codex-import-test-support.mjs";

const jiti = createJiti(import.meta.url);
const {
  CodexImportError,
  assertCodexImportAgentDir,
  convertCodexRollout,
  getCodexImportPaths,
  getCodexImportState,
  inspectCodexRollout,
  publishConvertedPiSession,
  validatePublishedPiSession,
  withCodexImportLock,
} = await jiti.import("./codex-import/index.ts");

/**
 * Create one valid converted session for storage tests.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function createConversion(fixture, threadId, sourceVersion = "source-v1") {
  const rolloutPath = join(fixture.codexHome, "sessions", `${threadId}.jsonl`);
  writeCodexRollout(rolloutPath, createVisibleCodexRecords(threadId, fixture.workspace, fixture.workspace));
  const inspection = await inspectCodexRollout({
    threadId,
    rolloutPath,
    sqliteSource: "vscode",
    sqliteThreadSource: "user",
  });
  return convertCodexRollout({
    candidate: { id: threadId, name: "Storage fixture", archived: false, sourceKind: "root", rolloutPath },
    inspection,
    snapshotPath: rolloutPath,
    targetCwd: fixture.workspace,
    sourceVersion,
  });
}

test("serializes concurrent imports and recovers a stale lock", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000020";
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withCodexImportLock({ agentDir: fixture.agentDir, threadId, staleMs: 100 }, async () => firstGate);

  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(
    () => withCodexImportLock({ agentDir: fixture.agentDir, threadId, staleMs: 100, retries: 0 }, async () => undefined),
    (error) => error instanceof CodexImportError && error.code === "IMPORT_LOCKED",
  );
  releaseFirst();
  await first;

  const paths = getCodexImportPaths(fixture.agentDir);
  const lockTarget = join(paths.locks, `${threadId}.target`);
  mkdirSync(`${lockTarget}.lock`, { recursive: true });
  const old = new Date(Date.now() - 10_000);
  utimesSync(`${lockTarget}.lock`, old, old);
  const recovered = await withCodexImportLock(
    { agentDir: fixture.agentDir, threadId, staleMs: 50, retries: 1 },
    async () => "recovered",
  );
  assert.equal(recovered, "recovered");
});

test("test-mode production protection ignores a caller-supplied productionAgentDir", () => {
  const production = join(homedir(), ".pi", "agent");
  assert.throws(
    () => assertCodexImportAgentDir(production, {
      testMode: true,
      productionAgentDir: join(homedir(), "fake-production-override"),
    }),
    (error) => error instanceof CodexImportError && error.code === "PRODUCTION_AGENT_DIR_REJECTED",
  );
});

test("rejects staging path traversal and linked import infrastructure", (t) => {
  const fixture = createCodexImportTestRoot(t);
  const paths = getCodexImportPaths(fixture.agentDir);
  const outside = join(fixture.root, "outside");
  mkdirSync(outside);
  mkdirSync(paths.root, { recursive: true });
  symlinkSync(outside, paths.staging, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => getCodexImportPaths(join(fixture.agentDir, "..", ".pi-agent", "..", "escape")),
    (error) => error instanceof CodexImportError,
  );
  assert.throws(
    () => assertCodexImportAgentDir(fixture.agentDir),
    (error) => error instanceof CodexImportError && error.code === "LINKED_PATH_REJECTED",
  );
});

test("keeps staging invisible and leaves no published session when atomic publication fails", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000021";
  const conversion = await createConversion(fixture, threadId);

  await assert.rejects(
    () => publishConvertedPiSession({
      agentDir: fixture.agentDir,
      conversion,
      beforePublish: () => {
        throw new Error("injected publication failure");
      },
    }),
    /injected publication failure/,
  );

  const sessionsRoot = join(fixture.agentDir, "sessions");
  const publishedFiles = readdirSync(sessionsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  assert.equal(publishedFiles.length, 0);
});

test("checks cancellation immediately before the atomic link commit", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000023";
  const conversion = await createConversion(fixture, threadId);
  const controller = new AbortController();
  await assert.rejects(
    () => publishConvertedPiSession({
      agentDir: fixture.agentDir,
      conversion,
      signal: controller.signal,
      beforePublish: () => controller.abort(),
    }),
    (error) => error instanceof CodexImportError && error.code === "IMPORT_CANCELLED",
  );
  const sessionsRoot = join(fixture.agentDir, "sessions");
  const publishedFiles = readdirSync(sessionsRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  assert.equal(publishedFiles.length, 0);
});

test("publishes without overwrite, validates SessionManager open/buildContext, and reports source changes", async (t) => {
  const fixture = createCodexImportTestRoot(t);
  const threadId = "01900000-0000-7000-8000-000000000022";
  const conversion = await createConversion(fixture, threadId, "source-v1");
  const published = await publishConvertedPiSession({ agentDir: fixture.agentDir, conversion });
  const validation = await validatePublishedPiSession(published.filePath, fixture.workspace);

  assert.equal(validation.sessionId, conversion.header.id);
  assert.equal(validation.cwd, fixture.workspace);
  assert.ok(validation.contextMessageCount > 0);
  assert.equal(validation.toolCallCount, validation.toolResultCount);

  const exact = await getCodexImportState(fixture.agentDir, threadId, "source-v1");
  assert.equal(exact.status, "already_imported");
  assert.equal(exact.sessionId, conversion.header.id);
  const changed = await getCodexImportState(fixture.agentDir, threadId, "source-v2");
  assert.equal(changed.status, "source_changed");

  await assert.rejects(
    () => publishConvertedPiSession({ agentDir: fixture.agentDir, conversion, forcedFileName: published.fileName }),
    (error) => error instanceof CodexImportError && error.code === "SESSION_ALREADY_EXISTS",
  );
});
