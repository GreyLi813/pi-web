import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { prepareTestRuntime, TEST_WEB_PORT } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);

/** Start Pi-Web against the local Pi Agent checkout and isolated test data.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
async function main() {
  const runtime = await prepareTestRuntime({
    testAgentDir: process.env.PI_WEB_TEST_AGENT_DIR || undefined,
  });
  const nextBin = require.resolve("next/dist/bin/next");

  console.log(`[pi-web:test] URL: http://localhost:${TEST_WEB_PORT}`);
  console.log(`[pi-web:test] Pi Agent source: ${runtime.packages["pi-coding-agent"].sourcePath}`);
  console.log(`[pi-web:test] Pi Agent snapshot: ${runtime.packages["pi-coding-agent"].targetPath}`);
  console.log(`[pi-web:test] Pi Agent SHA-256: ${runtime.packages["pi-coding-agent"].indexSha256}`);
  console.log(`[pi-web:test] Pi Agent data: ${runtime.paths.testAgentDir}`);
  console.log(`[pi-web:test] Cron extension: ${runtime.cronExtension}`);

  const child = spawn(process.execPath, [nextBin, "dev", "-p", TEST_WEB_PORT], {
    cwd: runtime.paths.webRoot,
    env: runtime.environment,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`[pi-web:test] Failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`[pi-web:test] Next.js stopped by ${signal}`);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => {
  console.error(`[pi-web:test] Refused to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
