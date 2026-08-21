import {
  PEER_SESSION_HOOKS_VERSION,
  type PeerPromptRequest,
  type PeerSessionExtensionHooks,
} from "@earendil-works/pi-coding-agent";
import { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } from "./session-reader";

export interface WebPeerAgent {
  readonly sessionFile?: string;
  readonly sessionFileKey?: string;
  isAlive(): boolean;
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  shutdownIfIdleAndEmpty(): Promise<boolean>;
}

export interface WebPeerSessionStartResult {
  agent: WebPeerAgent;
  /** True only when this caller, rather than a concurrent scheduler, created the wrapper. */
  created: boolean;
}

export interface WebPeerSessionHookDependencies {
  agentDir: string;
  startSession(request: PeerPromptRequest): Promise<WebPeerSessionStartResult>;
  getSession(sessionId: string): WebPeerAgent | undefined;
  cacheSessionPath?(sessionId: string, sessionFile: string): void;
  invalidateSessionPath?(sessionId: string): void;
  invalidateSessionList?(): void;
}

/** Read a text field from an RPC result without weakening its boundary type.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
function resultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/** Read the wrapper's monotonic run epoch from a state response.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function stateRunEpoch(result: unknown): number {
  if (!result || typeof result !== "object") throw new Error("Peer runtime returned invalid state");
  const epoch = (result as { runEpoch?: unknown }).runEpoch;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) {
    throw new Error("Peer runtime returned an invalid run epoch");
  }
  return epoch as number;
}

/** Ensure a cached live wrapper still represents the exact verified peer file.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function assertExactLivePeer(agent: WebPeerAgent, request: PeerPromptRequest): void {
  if (agent.sessionFile !== request.sessionFile) {
    throw new Error("Live peer wrapper does not match the verified Session file");
  }
  if (agent.sessionFileKey !== request.target.identity.fileKey) {
    throw new Error("Live peer wrapper physical identity/file key does not match authority");
  }
}

/** Run one exact, run-scoped prompt without resolving the Session ID globally.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
async function promptWebPeer(
  dependencies: Required<Omit<WebPeerSessionHookDependencies, "startSession" | "getSession">>
    & Pick<WebPeerSessionHookDependencies, "startSession" | "getSession">,
  request: PeerPromptRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (request.version !== 2 || request.agentDir !== dependencies.agentDir) {
    throw new Error("Peer hook Agent directory authorization does not match");
  }
  let agent = dependencies.getSession(request.sessionId);
  let ownsEmptyStartup = false;
  if (agent?.isAlive()) assertExactLivePeer(agent, request);
  else {
    const started = await dependencies.startSession(request);
    agent = started.agent;
    ownsEmptyStartup = started.created;
  }
  let succeeded = false;
  let settled = false;
  let cancel: (() => void) | undefined;
  try {
    assertExactLivePeer(agent, request);
    if (agent.isRunning()) throw new Error(`Peer Session ${request.sessionId} is busy`);
    if (signal?.aborted) throw new Error("Peer prompt was aborted before it started");

    const state = await agent.send({ type: "get_state" });
    const runEpoch = stateRunEpoch(state) + 1;
    cancel = (): void => {
      if (settled) return;
      void agent.send({ type: "cancel_run", runId: request.runId, runEpoch }).catch(() => {
        // The awaited prompt owns terminal error reporting.
      });
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      throw new Error("Peer prompt was aborted before it started");
    }
    const result = await agent.send({
      type: "peer_prompt_and_wait",
      message: request.prompt,
      runId: request.runId,
      runEpoch,
    });
    settled = true;
    if (signal?.aborted) throw new Error("Peer prompt was aborted");
    succeeded = true;
    dependencies.invalidateSessionList();
    return resultText(result) ?? "";
  } finally {
    settled = true;
    if (cancel) signal?.removeEventListener("abort", cancel);
    if (
      ownsEmptyStartup
      && !succeeded
      && agent.isAlive()
      && dependencies.getSession(request.sessionId) === agent
    ) {
      await agent.shutdownIfIdleAndEmpty();
    }
  }
}

/** Build version-matched Pi-Web hooks over the shared exact-file RPC registry.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
export function createWebPeerSessionHooks(
  dependencies: Pick<WebPeerSessionHookDependencies, "agentDir" | "startSession" | "getSession">
    & Partial<Omit<WebPeerSessionHookDependencies, "agentDir" | "startSession" | "getSession">>,
): PeerSessionExtensionHooks {
  const resolved = {
    cacheSessionPath,
    invalidateSessionPath: invalidateSessionPathCache,
    invalidateSessionList: invalidateSessionListCache,
    ...dependencies,
  } as Required<WebPeerSessionHookDependencies>;
  return {
    version: PEER_SESSION_HOOKS_VERSION,
    agentDir: resolved.agentDir,
    onPeerSessionCreated: (descriptor, target) => {
      if (descriptor.sessionFile !== target.identity.sessionFile) {
        throw new Error("Peer creation identity does not match its verified Session file");
      }
      resolved.cacheSessionPath(descriptor.sessionId, descriptor.sessionFile);
      resolved.invalidateSessionList();
    },
    onPeerSessionDiscarded: (descriptor) => {
      resolved.invalidateSessionPath(descriptor.sessionId);
      resolved.invalidateSessionList();
    },
    onPeerSchedulesChanged: () => {
      // The server scheduler reads the shared ScheduleStore on every wake.
    },
    promptPeerSession: (request, signal) => promptWebPeer(resolved, request, signal),
  };
}
