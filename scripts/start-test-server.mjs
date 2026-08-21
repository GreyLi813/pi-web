import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { prepareTestRuntime } from "./test-runtime.mjs";

const require = createRequire(import.meta.url);
const runtime = await prepareTestRuntime({
  testAgentDir: "D:/AI/Codex/SomethingElse/.pi-test-agent/formal-agent",
});
const nextBin = require.resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "dev", "-p", "30142"], {
  cwd: process.cwd(),
  env: { ...runtime.environment, NO_PROXY: "127.0.0.1,localhost" },
  stdio: ["ignore", "inherit", "inherit"],
});
const shutdown = () => child.kill("SIGTERM");
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", shutdown);
await new Promise((resolve) => child.on("spawn", resolve));
console.log(`spawned next dev pid=${child.pid}`);
