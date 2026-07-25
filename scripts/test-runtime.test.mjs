import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeTestAgentDir,
  createTestRuntimeEnvironment,
  installLocalAgentSnapshots,
  resolveTestRuntimePaths,
  TEST_WEB_PORT,
} from "./test-runtime.mjs";

const PACKAGE_DIRECTORIES = [
  ["pi-ai", "ai"],
  ["pi-agent-core", "agent"],
  ["pi-tui", "tui"],
  ["pi-coding-agent", "coding-agent"],
];

/** Create a minimal fake workspace for package-snapshot tests.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
async function createFakeWorkspace() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-web-runtime-"));
  const webRoot = join(workspaceRoot, "pi-web");
  const agentRepo = join(workspaceRoot, "pi-agent");
  await Promise.all([
    mkdir(join(webRoot, "node_modules", "@earendil-works"), { recursive: true }),
    mkdir(join(agentRepo, "node_modules"), { recursive: true }),
  ]);

  for (const [, sourceDirectory] of PACKAGE_DIRECTORIES) {
    const packageRoot = join(agentRepo, "packages", sourceDirectory);
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: sourceDirectory }));
    await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n");
  }

  return { workspaceRoot, webRoot, agentRepo };
}

test("passes: installs every Pi dependency from the local pi-agent build", async (context) => {
  const workspace = await createFakeWorkspace();
  context.after(() => rm(workspace.workspaceRoot, { recursive: true, force: true }));
  const paths = resolveTestRuntimePaths({
    ...workspace,
    testAgentDir: join(workspace.workspaceRoot, ".pi-test-agent"),
    productionAgentDir: join(workspace.workspaceRoot, ".production-agent"),
  });

  const installed = await installLocalAgentSnapshots(paths);
  for (const [packageName, sourceDirectory] of PACKAGE_DIRECTORIES) {
    const targetPath = join(paths.webRoot, "node_modules", "@earendil-works", packageName);
    const sourcePath = join(paths.agentRepo, "packages", sourceDirectory);
    const marker = JSON.parse(await readFile(join(targetPath, ".pi-local-source.json"), "utf8"));
    assert.equal((await lstat(targetPath)).isSymbolicLink(), false);
    assert.equal(marker.sourcePath, sourcePath);
    assert.equal(marker.dependencyRoot, join(paths.agentRepo, "node_modules"));
    assert.equal(
      await realpath(join(targetPath, "node_modules")),
      await realpath(join(paths.agentRepo, "node_modules")),
    );
    assert.equal(installed[packageName].sourcePath, sourcePath);
    assert.equal(installed[packageName].targetPath, targetPath);
    assert.equal(installed[packageName].dependencyRoot, join(paths.agentRepo, "node_modules"));
    assert.equal(marker.indexSha256, installed[packageName].indexSha256);
    assert.equal(
      await readFile(join(targetPath, "dist", "index.js"), "utf8"),
      await readFile(join(sourcePath, "dist", "index.js"), "utf8"),
    );
  }
});

test("fails safely: rejects the production Pi Agent directory", () => {
  const productionAgentDir = join(tmpdir(), "production-pi-agent");
  assert.throws(
    () => assertSafeTestAgentDir(productionAgentDir, productionAgentDir),
    /Refusing to use production Pi Agent data/,
  );
  assert.throws(
    () => assertSafeTestAgentDir(join(productionAgentDir, "child"), productionAgentDir),
    /Refusing to use production Pi Agent data/,
  );
});

test("fails safely: refuses a local package without built output", async (context) => {
  const workspace = await createFakeWorkspace();
  context.after(() => rm(workspace.workspaceRoot, { recursive: true, force: true }));
  await rm(join(workspace.agentRepo, "packages", "coding-agent", "dist", "index.js"));
  const paths = resolveTestRuntimePaths({
    ...workspace,
    testAgentDir: join(workspace.workspaceRoot, ".pi-test-agent"),
    productionAgentDir: join(workspace.workspaceRoot, ".production-agent"),
  });

  await assert.rejects(() => installLocalAgentSnapshots(paths), /ENOENT/);
});

test("passes: launch environment overrides inherited production settings", () => {
  const paths = resolveTestRuntimePaths({
    webRoot: join(tmpdir(), "workspace", "pi-web"),
    agentRepo: join(tmpdir(), "workspace", "pi-agent"),
    testAgentDir: join(tmpdir(), "workspace", ".pi-test-agent"),
    productionAgentDir: join(tmpdir(), "production-agent"),
  });
  const environment = createTestRuntimeEnvironment(paths, {
    PI_CODING_AGENT_DIR: paths.productionAgentDir,
    PI_PACKAGE_DIR: "C:/production/pi-package",
    PORT: "30141",
  });

  assert.equal(environment.NODE_ENV, "development");
  assert.equal(environment.PI_CODING_AGENT_DIR, paths.testAgentDir);
  assert.equal(environment.PI_PACKAGE_DIR, "");
  assert.equal(environment.PORT, TEST_WEB_PORT);
  assert.equal(environment.PI_WEB_TEST_MODE, "1");
  assert.equal(environment.PI_WEB_AGENT_SOURCE_DIR, join(paths.agentRepo, "packages", "coding-agent"));
});
