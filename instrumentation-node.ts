import * as PiAgent from "@earendil-works/pi-coding-agent";
import { assertPiAgentProtocol } from "@/lib/agent-protocol";
import { configureHttpDispatcher } from "@/lib/http-dispatcher";
import { startPersistentSessionScheduler } from "@/lib/session-scheduler";

/** Initialize services that are valid only inside the Pi-Web Node process.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function registerNodeInstrumentation(): Promise<void> {
  assertPiAgentProtocol(PiAgent);
  configureHttpDispatcher();
  await startPersistentSessionScheduler();
}
