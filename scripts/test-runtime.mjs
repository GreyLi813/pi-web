import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const TEST_WEB_PORT = "30142";

const LOCAL_PACKAGES = [
  ["pi-ai", "ai"],
  ["pi-agent-core", "agent"],
  ["pi-tui", "tui"],
  ["pi-coding-agent", "coding-agent"],
];

/** Return true when candidate is equal to or contained by parent.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export function isPathWithin(candidate, parent) {
  const childPath = resolve(candidate);
  const parentPath = resolve(parent);
  const relation = relative(parentPath, childPath);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

/** Resolve all fixed paths used by the isolated test runtime.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export function resolveTestRuntimePaths(options = {}) {
  const webRoot = resolve(options.webRoot ?? join(import.meta.dirname, ".."));
  const workspaceRoot = resolve(options.workspaceRoot ?? join(webRoot, ".."));
  const agentRepo = resolve(options.agentRepo ?? join(workspaceRoot, "pi-agent"));
  const testAgentDir = resolve(options.testAgentDir ?? join(workspaceRoot, ".pi-test-agent"));
  const productionAgentDir = resolve(options.productionAgentDir ?? join(homedir(), ".pi", "agent"));

  return {
    webRoot,
    workspaceRoot,
    agentRepo,
    testAgentDir,
    productionAgentDir,
  };
}

/** Reject test data paths that could mutate the production Pi Agent directory.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export function assertSafeTestAgentDir(testAgentDir, productionAgentDir) {
  if (isPathWithin(testAgentDir, productionAgentDir)) {
    throw new Error(`Refusing to use production Pi Agent data for tests: ${testAgentDir}`);
  }
}

/** Calculate the SHA-256 digest of one built package entry point.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Install snapshots built from the local pi-agent checkout into test node_modules.
 *
 * Copies preserve Next.js external-package semantics; directory links cause
 * Turbopack to bundle Pi's dynamic runtime modules as application source.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function installLocalAgentSnapshots(paths) {
  const scopeDir = join(paths.webRoot, "node_modules", "@earendil-works");
  const dependencyRoot = join(paths.agentRepo, "node_modules");
  await Promise.all([
    mkdir(scopeDir, { recursive: true }),
    access(dependencyRoot),
  ]);

  const installedPackages = {};
  for (const [packageName, sourceDirectory] of LOCAL_PACKAGES) {
    const sourcePath = join(paths.agentRepo, "packages", sourceDirectory);
    const targetPath = join(scopeDir, packageName);
    const sourceEntryPoint = join(sourcePath, "dist", "index.js");
    await access(join(sourcePath, "package.json"));
    await access(sourceEntryPoint);
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourcePath, targetPath, {
      recursive: true,
      filter: (candidate) => !candidate.split(/[\\/]/).includes("node_modules"),
    });
    await symlink(
      dependencyRoot,
      join(targetPath, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const indexSha256 = await hashFile(sourceEntryPoint);
    const installedSha256 = await hashFile(join(targetPath, "dist", "index.js"));
    if (installedSha256 !== indexSha256) {
      throw new Error(`${packageName} snapshot differs from the local build`);
    }
    await writeFile(join(targetPath, ".pi-local-source.json"), JSON.stringify({
      sourcePath,
      dependencyRoot,
      indexSha256,
    }, null, 2));
    installedPackages[packageName] = { sourcePath, targetPath, dependencyRoot, indexSha256 };
  }

  return installedPackages;
}

/** Synchronize the local cron extension into the isolated test data directory.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function syncTestCronExtension(paths) {
  const sourcePath = join(paths.agentRepo, "packages", "coding-agent", "examples", "extensions", "cron.ts");
  const targetPath = join(paths.testAgentDir, "extensions", "cron.ts");
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetPath;
}

/** Build a child-process environment that cannot inherit production agent data.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export function createTestRuntimeEnvironment(paths, baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    NODE_ENV: "development",
    PORT: TEST_WEB_PORT,
    PI_CODING_AGENT_DIR: paths.testAgentDir,
    PI_PACKAGE_DIR: "",
    PI_WEB_TEST_MODE: "1",
    PI_WEB_AGENT_SOURCE_DIR: join(paths.agentRepo, "packages", "coding-agent"),
    PI_WEB_NO_OPEN: "1",
  };
}

/** Prepare local package snapshots, isolated data, and the local test extension.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function prepareTestRuntime(options = {}) {
  const paths = resolveTestRuntimePaths(options);
  assertSafeTestAgentDir(paths.testAgentDir, paths.productionAgentDir);
  await mkdir(paths.testAgentDir, { recursive: true });
  const packages = await installLocalAgentSnapshots(paths);
  const cronExtension = await syncTestCronExtension(paths);
  return {
    paths,
    packages,
    cronExtension,
    environment: createTestRuntimeEnvironment(paths, options.baseEnvironment),
  };
}
