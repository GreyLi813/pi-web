import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dialog = await readFile(new URL("./CodexImportDialog.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../hooks/useCodexImport.ts", import.meta.url), "utf8");
const actions = await readFile(new URL("../hooks/codex-import/useCodexImportActions.ts", import.meta.url), "utf8");
const filters = await readFile(new URL("./codex-import/CodexImportFilters.tsx", import.meta.url), "utf8");
const list = await readFile(new URL("./codex-import/CodexImportCandidateList.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("starts with no selected session and exposes no select-all action", () => {
  assert.match(hook, /useState<Set<string>>\(\(\) => new Set\(\)\)/);
  assert.doesNotMatch(`${dialog}\n${hook}\n${actions}\n${list}`, /selectAll|toggleAll|allSelected/);
  assert.match(dialog, /codexImport\.noBulkDefault/);
});

test("keeps name, workspace, sandbox, and latest-CWD filters independent", () => {
  for (const key of ["name", "workspace", "sandbox", "cwd"]) {
    assert.match(filters, new RegExp(`updateText\\(\\"${key}\\"`));
  }
  assert.match(hook, /includeArchived: false/);
  assert.match(hook, /includeSubagents: false/);
  assert.match(hook, /includeGuardians: false/);
});

test("requires explicit DirectoryPicker remapping for a missing CWD", () => {
  assert.match(dialog, /<DirectoryPicker/);
  assert.match(dialog, /state\.setRemap\(remapThreadId, path\)/);
  assert.match(list, /!session\.cwdExists/);
});

test("cancels at the server boundary and reconciles any atomic commit", () => {
  assert.match(dialog, /state\.cancelOperation/);
  assert.match(actions, /fetchCodexImportDetail\(session\.id\)/);
  assert.match(actions, /operationAbortRef\.current\?\.abort|operationAbortRef/);
});

test("keeps the import workflow outside SessionSidebar and wires only a small entry callback", () => {
  assert.match(sidebar, /onOpenCodexImport: \(\) => void/);
  assert.match(sidebar, /onClick=\{onOpenCodexImport\}/);
  assert.doesNotMatch(sidebar, /function CodexImportDialog|preflightCodexImport|runCodexImport/);
  assert.match(shell, /<CodexImportDialog/);
});
