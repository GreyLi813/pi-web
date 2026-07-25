import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

export const dynamic = "force-dynamic";

type LocalSourceMarker = {
  sourcePath: string;
  dependencyRoot: string;
  indexSha256: string;
};

/** Calculate a SHA-256 digest for runtime provenance checks.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Report the package and data paths actually loaded by the isolated test server.
 *
 * The endpoint is unavailable outside PI_WEB_TEST_MODE so production does not
 * expose local filesystem paths.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function GET(): Promise<Response> {
  if (process.env.PI_WEB_TEST_MODE !== "1") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const packageDir = getPackageDir();
  const expectedSourceDir = process.env.PI_WEB_AGENT_SOURCE_DIR ?? "";
  const [packageJson, marker] = await Promise.all([
    readFile(join(packageDir, "package.json"), "utf8").then((value) => JSON.parse(value) as { version: string }),
    readFile(join(packageDir, ".pi-local-source.json"), "utf8").then((value) => JSON.parse(value) as LocalSourceMarker),
  ]);
  const expectedDependencyRoot = resolve(expectedSourceDir, "..", "..", "node_modules");
  const [installedHash, sourceHash, actualDependencyRoot] = await Promise.all([
    hashFile(join(packageDir, "dist", "index.js")),
    hashFile(join(marker.sourcePath, "dist", "index.js")),
    realpath(join(packageDir, "node_modules")),
  ]);
  const sourceMatches = (
    resolve(marker.sourcePath) === resolve(expectedSourceDir)
    && resolve(marker.dependencyRoot) === expectedDependencyRoot
    && resolve(actualDependencyRoot) === expectedDependencyRoot
    && marker.indexSha256 === installedHash
    && marker.indexSha256 === sourceHash
  );

  return Response.json({
    mode: "test",
    port: process.env.PORT,
    piAgent: {
      version: packageJson.version,
      packageDir,
      sourceDir: marker.sourcePath,
      expectedSourceDir,
      dependencyRoot: actualDependencyRoot,
      sourceMatches,
      indexSha256: installedHash,
      dataDir: getAgentDir(),
    },
  }, { status: sourceMatches ? 200 : 500 });
}
