import * as PiAgent from "@earendil-works/pi-coding-agent";
import { assertPiAgentProtocol } from "@/lib/agent-protocol";
import { configureHttpDispatcher, readHttpIdleTimeoutMs } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startPersistentSessionScheduler } from "@/lib/session-scheduler";

export async function registerNodeInstrumentation(): Promise<void> {
  assertPiAgentProtocol(PiAgent);
  // The pi CLI applies settings' `httpIdleTimeoutMs` to the same undici
  // body/header timeouts, so a Web UI session gets the timeout the user
  // configured. Without it the built-in five minutes aborts a provider stream
  // that stays quiet for longer, which a CLI session tolerates.
  configureHttpDispatcher(readHttpIdleTimeoutMs());

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  // The static `PiAgent` import above loads the SDK at module load, so
  // upstream's unawaited dynamic preload (#964) is redundant here.
  await startPersistentSessionScheduler();
}
