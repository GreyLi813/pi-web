import { unlinkSync } from "node:fs";
import {
  acquireOrchestratedSessionDeletionLease,
  createOrchestratedSessionWithinQuota,
  describeOrchestratedSession,
  getSessionOrchestrationToolNames,
  isSessionOrchestrationMetadata,
  listOwnedOrchestratedSessions,
  MAX_ORCHESTRATION_PROMPT_LENGTH,
  resolveOwnedOrchestratedSession,
  SessionManager,
  type SessionOrchestrationCreateRequest,
  type SessionOrchestrationDescriptor,
  type SessionOrchestrationHost,
  type SessionOrchestrationOwner,
  type SessionOrchestrationOwnerCapability,
  type SessionOrchestrationPromptResult,
  type SessionOrchestrationStatus,
  type SessionOrchestrationUpdate,
  withOrchestratedSessionLock,
  withSessionOrchestrationOwnerLock,
} from "@earendil-works/pi-coding-agent";
import { contentText } from "@earendil-works/pi-ai";

export interface WebOrchestrationSession {
  isAlive(): boolean;
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
  destroyAndWait?(): Promise<void>;
}

export interface WebSessionOrchestrationDependencies {
  startSession(
    sessionId: string,
    sessionFile: string,
    cwd: string,
    toolNames: string[],
    ownerCapability: SessionOrchestrationOwnerCapability | undefined,
  ): Promise<WebOrchestrationSession>;
  getSession(sessionId: string): WebOrchestrationSession | undefined;
  cacheSessionPath(sessionId: string, sessionFile: string): void;
  invalidateSessionPath(sessionId: string): void;
  invalidateSessionList(): void;
}

/** Extract the latest assistant text without starting a runtime.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function getPersistedLastAssistantText(manager: SessionManager): string | undefined {
  const messages = manager.buildSessionContext().messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant") return contentText(message.content);
  }
  return undefined;
}

/** Read a text field from an RPC result without weakening its boundary type.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function resultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const text = (result as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/** Pi-Web orchestration host backed by the existing one-wrapper-per-session registry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export class WebSessionOrchestrationHost implements SessionOrchestrationHost {
  private readonly dependencies: WebSessionOrchestrationDependencies;

  /** Bind the host to Pi-Web's runtime registry primitives.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  constructor(dependencies: WebSessionOrchestrationDependencies) {
    this.dependencies = dependencies;
  }

  /** Create and index one immediately persisted clean worker.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async createSession(
    owner: SessionOrchestrationOwner,
    request: SessionOrchestrationCreateRequest,
    signal?: AbortSignal,
  ): Promise<SessionOrchestrationDescriptor> {
    const created = await createOrchestratedSessionWithinQuota(owner, request, signal);
    const sessionFile = created.manager.getSessionFile();
    if (!sessionFile) throw new Error("Worker session persistence is unavailable");
    this.dependencies.cacheSessionPath(created.sessionId, sessionFile);
    this.dependencies.invalidateSessionList();
    return {
      sessionId: created.sessionId,
      name: created.name,
      cwd: created.cwd,
      kind: created.kind,
      toolProfile: created.toolProfile,
      model: created.model,
      thinkingLevel: created.thinkingLevel,
    };
  }

  /** Route one complete worker turn through the shared RPC wrapper and wait for it.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async promptSession(
    owner: SessionOrchestrationOwner,
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    onUpdate?: (update: SessionOrchestrationUpdate) => void,
  ): Promise<SessionOrchestrationPromptResult> {
    if (!prompt.trim()) throw new Error("Worker prompt cannot be empty");
    if (prompt.length > MAX_ORCHESTRATION_PROMPT_LENGTH) {
      throw new Error(`Worker prompt cannot exceed ${MAX_ORCHESTRATION_PROMPT_LENGTH} characters`);
    }
    if (signal?.aborted) throw new Error("Worker prompt was aborted");

    const manager = await resolveOwnedOrchestratedSession(owner, sessionId);
    if (signal?.aborted) throw new Error("Worker prompt was aborted");
    const metadata = manager.getHeader()?.orchestration;
    const sessionFile = manager.getSessionFile();
    if (!isSessionOrchestrationMetadata(metadata) || !sessionFile) {
      throw new Error("Worker session metadata is invalid");
    }

    return withOrchestratedSessionLock(manager, async () => {
      if (signal?.aborted) throw new Error("Worker prompt was aborted");
      const existing = this.dependencies.getSession(sessionId);
      if (existing?.isAlive() && existing.isRunning()) {
        throw new Error(`Worker session ${sessionId} is busy`);
      }

      const session = await this.dependencies.startSession(
        sessionId,
        sessionFile,
        manager.getCwd(),
        getSessionOrchestrationToolNames(metadata.toolProfile),
        owner.ownerCapability,
      );
      if (session.isRunning()) throw new Error(`Worker session ${sessionId} is busy`);

      const abort = (): void => {
        void session.send({ type: "abort" }).catch(() => {
          // Preserve the original prompt result/error when cancellation races completion.
        });
      };
      signal?.addEventListener("abort", abort, { once: true });

      try {
        if (signal?.aborted) {
          abort();
          throw new Error("Worker prompt was aborted");
        }
        onUpdate?.({ sessionId, message: "Worker session is running" });
        const result = await session.send({
          type: "orchestrated_prompt",
          message: prompt,
          modelProvider: metadata.model?.provider,
          modelId: metadata.model?.modelId,
          thinkingLevel: metadata.thinkingLevel,
        });
        const response = resultText(result)
          ?? resultText(await session.send({ type: "get_last_assistant_text" }))
          ?? "";
        this.dependencies.invalidateSessionList();
        return { sessionId, response };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    });
  }

  /** Inspect persisted workers and merge their live Pi-Web running state.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async getSessionStatus(
    owner: SessionOrchestrationOwner,
    sessionId?: string,
  ): Promise<SessionOrchestrationStatus[]> {
    if (sessionId) await resolveOwnedOrchestratedSession(owner, sessionId);
    const allOwned = await listOwnedOrchestratedSessions(owner);
    const infos = sessionId ? allOwned.filter((info) => info.id === sessionId) : allOwned;

    return Promise.all(infos.map(async (info) => {
      const live = this.dependencies.getSession(info.id);
      let lastAssistantText: string | undefined;
      if (live?.isAlive()) {
        lastAssistantText = resultText(await live.send({ type: "get_last_assistant_text" }));
      } else {
        lastAssistantText = getPersistedLastAssistantText(SessionManager.open(info.path, owner.sessionDir || undefined));
      }
      return {
        ...describeOrchestratedSession(info),
        state: live?.isAlive() && live.isRunning() ? "running" : "idle",
        lastAssistantText,
      };
    }));
  }

  /** Abort a live owned wrapper without deleting its JSONL history.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async abortSession(owner: SessionOrchestrationOwner, sessionId: string): Promise<boolean> {
    await resolveOwnedOrchestratedSession(owner, sessionId);
    const live = this.dependencies.getSession(sessionId);
    if (!live?.isAlive() || !live.isRunning()) return false;
    await live.send({ type: "abort" });
    return true;
  }

  /** Remove a cancelled delegate only if no worker turn reached persistent history.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async discardSessionIfEmpty(owner: SessionOrchestrationOwner, sessionId: string): Promise<boolean> {
    return withSessionOrchestrationOwnerLock(owner, async () => {
      const manager = await resolveOwnedOrchestratedSession(owner, sessionId);
      const live = this.dependencies.getSession(sessionId);
      if (live?.isAlive() && live.isRunning()) return false;
      return withOrchestratedSessionLock(manager, async () => {
        const currentFile = manager.getSessionFile();
        if (!currentFile) return false;
        const current = SessionManager.open(currentFile, owner.sessionDir || undefined);
        if (current.getEntries().some((entry) => entry.type !== "session_info")) return false;
        await live?.destroyAndWait?.();
        let deletionLease: Awaited<ReturnType<typeof acquireOrchestratedSessionDeletionLease>> | undefined;
        try {
          deletionLease = await acquireOrchestratedSessionDeletionLease(current);
          if (current.getEntries().some((entry) => entry.type !== "session_info")) return false;
          unlinkSync(currentFile);
          this.dependencies.invalidateSessionPath(sessionId);
          this.dependencies.invalidateSessionList();
          return true;
        } finally {
          await deletionLease?.release().catch(() => undefined);
        }
      });
    });
  }
}

/** Build the Pi-Web host from registry dependencies for tests and runtime wiring.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function createWebSessionOrchestrationHost(
  dependencies: WebSessionOrchestrationDependencies,
): WebSessionOrchestrationHost {
  return new WebSessionOrchestrationHost(dependencies);
}
