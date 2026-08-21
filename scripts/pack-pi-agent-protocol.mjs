import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const EXPECTED_PROTOCOL_VERSION = 3;
const REQUIRED_APIS = [
  "ScheduleStore",
  "ScheduleStore.markPendingTerminal",
  "authorizePeerSessionRuntime",
  "verifyStoredSessionTarget",
];
const REQUIRED_SCHEDULE_STATES = ["pending-terminal"];
const LOCAL_PACKAGES = [
  ["@earendil-works/pi-ai", "ai"],
  ["@earendil-works/pi-agent-core", "agent"],
  ["@earendil-works/pi-tui", "tui"],
  ["@earendil-works/pi-protocol", "protocol"],
  ["@earendil-works/pi-client", "client"],
  ["@earendil-works/pi-coding-agent", "coding-agent"],
];

/** Read one command-line option value.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Run npm portably without invoking a shell.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function npm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return execFileAsync(process.execPath, [npmCli, ...args], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  }
  return execFileAsync("npm", args, {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

/** Calculate a reproducible digest for one packed artifact.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Verify protocol identity plus nested ScheduleStore capabilities.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertProtocolSurface(surface, label) {
  if (surface.PI_WEB_AGENT_PROTOCOL_VERSION !== EXPECTED_PROTOCOL_VERSION) {
    throw new Error(`${label} has protocol ${String(surface.PI_WEB_AGENT_PROTOCOL_VERSION)}; expected ${EXPECTED_PROTOCOL_VERSION}`);
  }
  for (const api of REQUIRED_APIS) {
    const candidate = api === "ScheduleStore.markPendingTerminal"
      ? surface.ScheduleStore?.prototype?.markPendingTerminal
      : surface[api];
    if (typeof candidate !== "function") throw new Error(`${label} is missing ${api}`);
  }
  for (const state of REQUIRED_SCHEDULE_STATES) {
    if (!Array.isArray(surface.SCHEDULE_STORE_STATES) || !surface.SCHEDULE_STORE_STATES.includes(state)) {
      throw new Error(`${label} is missing Schedule state ${state}`);
    }
  }
}

/** Verify one clean npm-ci installation from only the generated tarballs.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function runCleanInstallSmoke(outputDir, artifacts) {
  const smokeDir = await mkdtemp(join(tmpdir(), "pi-web-agent-protocol-smoke-"));
  try {
    const dependencies = Object.fromEntries(artifacts.map((artifact) => [
      artifact.name,
      `file:${resolve(outputDir, artifact.filename).replaceAll("\\", "/")}`,
    ]));
    await writeFile(join(smokeDir, "package.json"), JSON.stringify({
      name: "pi-web-agent-protocol-smoke",
      private: true,
      type: "module",
      dependencies,
    }, null, 2));
    await npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: smokeDir });
    await npm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: smokeDir });
    const verification = [
      "const m = await import('@earendil-works/pi-coding-agent');",
      `if (m.PI_WEB_AGENT_PROTOCOL_VERSION !== ${EXPECTED_PROTOCOL_VERSION}) throw new Error('protocol version');`,
      `const requiredApis = ${JSON.stringify(REQUIRED_APIS)};`,
      "for (const name of requiredApis) {",
      "  const value = name === 'ScheduleStore.markPendingTerminal' ? m.ScheduleStore?.prototype?.markPendingTerminal : m[name];",
      "  if (typeof value !== 'function') throw new Error(name);",
      "}",
      `for (const state of ${JSON.stringify(REQUIRED_SCHEDULE_STATES)})`,
      "  if (!Array.isArray(m.SCHEDULE_STORE_STATES) || !m.SCHEDULE_STORE_STATES.includes(state)) throw new Error(state);",
      "console.log('clean npm ci protocol smoke passed');",
    ].join("\n");
    const result = await execFileAsync(process.execPath, ["--input-type=module", "--eval", verification], {
      cwd: smokeDir,
      windowsHide: true,
    });
    process.stdout.write(result.stdout);
  } finally {
    await rm(smokeDir, { recursive: true, force: true });
  }
}

/** Pack the adjacent source tree and emit a hash manifest/release gate.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function main() {
  const webRoot = resolve(import.meta.dirname, "..");
  const agentRepo = resolve(option("--agent-repo") ?? join(webRoot, "..", "pi-agent"));
  const explicitOutput = option("--output");
  const outputDir = resolve(explicitOutput ?? await mkdtemp(join(tmpdir(), "pi-agent-protocol-v3-")));
  const smoke = process.argv.includes("--smoke");
  await mkdir(outputDir, { recursive: true });

  const codingEntry = join(agentRepo, "packages", "coding-agent", "dist", "index.js");
  const coding = await import(`${pathToFileURL(codingEntry).href}?verify=${Date.now()}`);
  assertProtocolSurface(coding, "Adjacent pi-agent dist");

  const artifacts = [];
  for (const [name, directory] of LOCAL_PACKAGES) {
    const packageRoot = join(agentRepo, "packages", directory);
    const { stdout } = await npm([
      "pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", outputDir,
    ], { cwd: webRoot });
    const packed = JSON.parse(stdout)[0];
    const artifactPath = join(outputDir, packed.filename);
    artifacts.push({
      name,
      version: packed.version,
      filename: basename(artifactPath),
      sha256: await sha256(artifactPath),
      size: packed.size,
      integrity: packed.integrity,
    });
  }

  const manifest = {
    protocolVersion: EXPECTED_PROTOCOL_VERSION,
    requiredApis: REQUIRED_APIS,
    requiredScheduleStates: REQUIRED_SCHEDULE_STATES,
    generatedBy: "pi-web/scripts/pack-pi-agent-protocol.mjs",
    artifacts,
  };
  await writeFile(join(outputDir, "pi-agent-protocol-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (smoke) await runCleanInstallSmoke(outputDir, artifacts);
  console.log(`Pi Agent protocol artifacts: ${outputDir}`);
  if (!explicitOutput && !smoke) console.log("Pass --output <directory> to retain artifacts for release.");
  if (!explicitOutput && smoke) await rm(outputDir, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
