import * as PiAgent from "@earendil-works/pi-coding-agent";
import { assertPiAgentProtocol } from "@/lib/agent-protocol";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { closeAllAgentEventStreams } from "@/lib/agent-event-stream";
import { startPersistentSessionScheduler } from "@/lib/session-scheduler";

/** Initialize services that are valid only inside the Pi-Web Node process.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function registerNodeInstrumentation(): Promise<void> {
  assertPiAgentProtocol(PiAgent);
  configureHttpDispatcher();

  // In production Next 16 answers SIGINT/SIGTERM with server.close() and waits
  // for every connection to end, without a timeout. SSE streams only end when
  // the client disconnects, so close them here or the process never exits.
  const shutdownStreams = () => closeAllAgentEventStreams();
  process.on("SIGINT", shutdownStreams);
  process.on("SIGTERM", shutdownStreams);

  await startPersistentSessionScheduler();
}
