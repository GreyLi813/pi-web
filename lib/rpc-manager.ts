import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  acquireOrchestratedSessionRuntimeLease,
  acquireSessionFileLease,
  acquireSessionIdentityLease,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createModelEndpointFingerprint,
  createPeerSessionExtension,
  createSessionOrchestrationExtension,
  getAgentDir,
  getAuthorizedPeerRuntimePolicy,
  getSessionOrchestrationToolNames,
  initTheme,
  isolateOrchestratedSessionExtensions,
  isSessionOrchestrationMetadata,
  type OrchestratedSessionRuntimeLease,
  SessionManager,
  PeerAuthorityStore,
  type PeerSessionRuntimeAuthority,
  type SessionIdentityLease,
  type SessionOrchestrationOwnerCapability,
  SettingsManager,
  storeSessionTarget,
  type StoredSessionTarget,
  Theme,
  verifySessionTarget,
  verifyStoredSessionTarget,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } from "./session-reader";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import { createWebSessionOrchestrationHost, type WebSessionOrchestrationHost } from "./session-orchestration-host";
import { createWebPeerSessionHooks } from "./peer-session-hooks";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ExtensionWidgetComponent = {
  render: (width: number) => unknown;
  dispose?: () => void;
};

type ExtensionWidgetFactory = (tui: HeadlessCustomUiTui, theme: Theme) => unknown;

type ActiveExtensionWidget = {
  key: string;
  component: ExtensionWidgetComponent;
  placement: "aboveEditor" | "belowEditor";
  generation: number;
  clearEmitted: boolean;
  rendered: boolean;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionCommandContextActionsLike = {
  waitForIdle: () => Promise<void>;
  newSession: () => Promise<{ cancelled: boolean }>;
  fork: () => Promise<{ cancelled: boolean }>;
  navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
  switchSession: () => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

type PromptRunHandle = {
  runId: string;
  runEpoch: number;
  completion: Promise<void>;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const RUN_EPOCH_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "prompt_done",
  "prompt_error",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const ORCHESTRATION_OWNER_HOST_CAPABILITY = Symbol("orchestration-owner-host");
const PEER_OWNER_HOST_CAPABILITY = Symbol("peer-owner-host");

export interface StartRpcSessionOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  includeExtensionTools?: boolean;
  enableSessionOrchestration?: boolean;
  preserveSystemPromptWithoutTools?: boolean;
  /** Internal identity proving that WebSessionOrchestrationHost validated ownership. */
  orchestrationOwnerHostCapability?: symbol;
  /** Opaque authority minted by the active owning controller extension. */
  orchestrationOwnerCapability?: SessionOrchestrationOwnerCapability;
  /** Internal identity proving that peer authority was checked by a host path. */
  peerOwnerHostCapability?: symbol;
  /** Opaque host-side authority binding a peer's complete runtime policy. */
  peerSessionRuntime?: PeerSessionRuntimeAuthority;
  /** Previously verified physical identity that must survive startup TOCTOU. */
  expectedSessionTarget?: StoredSessionTarget;
}

export interface PersistedRuntimePolicy {
  kind?: "orchestration" | "peer";
  toolNames: string[];
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  endpointFingerprint?: string;
  projectTrusted?: boolean;
}

export type OrchestratedRuntimePolicy = PersistedRuntimePolicy;

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const extensionToolNames = session
    .getAllTools()
    .map((t) => t.name)
    .filter((name) => !codingToolNames.has(name));

  return [...new Set([...toolNames, ...extensionToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private scheduledPromptStarting = false;
  private pendingRunAdmissions = 0;
  private promptCompletion: Promise<void> | null = null;
  private activeExtensionWidgets = new Map<string, ActiveExtensionWidget>();
  private extensionWidgetGenerations = new Map<string, number>();
  private extensionWidgetsResetting = false;
  private pendingPromptCount = 0;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private runEpoch = 0;
  private activeRunId: string | null = null;
  private activeRunEpoch: number | null = null;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void | Promise<void>) | null = null;
  private destroyCompletion: Promise<void> | null = null;
  private deletionReserved = false;
  private shutdownPromise: Promise<void> | null = null;
  private _alive = true;

  constructor(
    public readonly inner: AgentSessionLike,
    private readonly runtimePolicy?: PersistedRuntimePolicy,
    private readonly startupExactToolNames?: readonly string[],
    private readonly ensureSessionLease?: () => Promise<void>,
    private readonly runtimeTarget?: StoredSessionTarget | (() => StoredSessionTarget | undefined),
  ) {}

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  get streamingMessage() {
    return this.inner.agent.state?.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.inner.isStreaming;
  }

  private currentRuntimeTarget(): StoredSessionTarget | undefined {
    return typeof this.runtimeTarget === "function" ? this.runtimeTarget() : this.runtimeTarget;
  }

  get sessionFileKey(): string | undefined {
    return this.currentRuntimeTarget()?.fileKey;
  }

  /** Verify that an internal owner path still addresses this exact physical Session.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  matchesSessionTarget(target: StoredSessionTarget): boolean {
    return this.sessionId === target.sessionId
      && resolve(this.sessionFile) === resolve(target.sessionFile)
      && this.currentRuntimeTarget()?.fileKey === target.fileKey;
  }

  isAlive(): boolean {
    return this._alive;
  }

  /** Atomically prevent new commands when an idle Session is about to be deleted.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  reserveDeletion(): boolean {
    if (!this._alive || this.deletionReserved || this.isRunning()) return false;
    this.deletionReserved = true;
    return true;
  }

  /** Reopen command admission when deletion fails before unlinking the Session.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  releaseDeletionReservation(): void {
    this.deletionReserved = false;
  }

  /** Report whether persisted orchestration policy governs this wrapper.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  isOrchestratedWorker(): boolean {
    return this.runtimePolicy !== undefined && this.runtimePolicy.kind !== "peer";
  }

  /** Report whether durable peer policy governs this wrapper.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  isPeerSession(): boolean {
    return this.runtimePolicy?.kind === "peer";
  }

  /** Report whether model-facing mutations require a dedicated owner path.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  isRestrictedModelControlledSession(): boolean {
    return this.runtimePolicy !== undefined;
  }

  isRunning(): boolean {
    return this._alive && (
      this.pendingRunAdmissions > 0
      || this.scheduledPromptStarting
      || this.promptRunning
      || this.pendingPromptCount > 0
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
    );
  }

  /** Subscribe to SDK events and attach the active server run identity.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_start" && this.activeRunId === null) {
        this.runEpoch += 1;
        this.activeRunId = `extension-${randomUUID()}`;
        this.activeRunEpoch = this.runEpoch;
      }
      if (event.type === "agent_end") invalidateSessionListCache();
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(this.withRunIdentity(event));
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
      if (event.type === "agent_settled" && this.promptCompletion === null) this.clearActiveRun();
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Add the current run epoch to events that can mutate client prompt state.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private withRunIdentity(event: AgentEvent): AgentEvent {
    if (!RUN_EPOCH_EVENT_TYPES.has(event.type) || this.activeRunId === null || this.activeRunEpoch === null) {
      return event;
    }
    return { ...event, runId: this.activeRunId, runEpoch: this.activeRunEpoch };
  }

  /** Clear one active run without changing the monotonic epoch.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private clearActiveRun(runId?: string, runEpoch?: number): void {
    if (runId !== undefined && this.activeRunId !== runId) return;
    if (runEpoch !== undefined && this.activeRunEpoch !== runEpoch) return;
    this.activeRunId = null;
    this.activeRunEpoch = null;
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      const uiContext = this.createExtensionUiContext();
      if (typeof this.inner.bindExtensions === "function") {
        const bindExtensions = this.inner.bindExtensions as (bindings: {
          uiContext?: ExtensionUiContextLike;
          mode?: "rpc";
          commandContextActions?: ExtensionCommandContextActionsLike;
          shutdownHandler?: () => void;
          onError?: (error: { extensionPath: string; event: string; error: string }) => void;
        }) => Promise<void>;
        await bindExtensions.call(this.inner, {
          uiContext,
          mode: "rpc",
          commandContextActions: this.createExtensionCommandContextActions(),
          shutdownHandler: () => this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: "Extension requested shutdown, but shutdown is not supported in Pi Web.",
          } as ExtensionUiRequest as AgentEvent),
          onError: (error) => this.emit({
            type: "extension_error",
            extensionPath: error.extensionPath,
            event: error.event,
            error: error.error,
          }),
        });
      } else {
        this.inner.extensionRunner.setUIContext?.(uiContext, "rpc");
      }
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[pi-web] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "scheduled_prompt"
      || type === "orchestrated_prompt"
      || type === "peer_prompt_and_wait"
      || type === "steer"
      || type === "follow_up"
      || type === "get_tools"
      || type === "get_schedule_policy"
      || type === "set_tools"
      || type === "set_tools_exact"
      || type === "get_commands"
      || type === "get_state";
  }

  /** Reapply an exact initial tool set after extensions register tools.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private applyStartupExactTools(): void {
    if (!this.runtimePolicy && this.startupExactToolNames) {
      this.inner.setActiveToolsByName([...this.startupExactToolNames]);
    }
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = "";
    }
  }

  private emit(event: AgentEvent): void {
    const identified = RUN_EPOCH_EVENT_TYPES.has(event.type)
      ? { ...event, runtimeInstanceId: getRpcRuntimeInstanceId() }
      : event;
    for (const listener of this.listeners) {
      try {
        listener(identified);
      } catch (error) {
        console.error(
          `[pi-web] failed to deliver ${event.type} event:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async acquirePromptAdmission(): Promise<() => void> {
    const previous = this.promptAdmissionTail;
    let release!: () => void;
    this.promptAdmissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // A visible chat keeps an SSE listener attached so server-dispatched
      // schedules can stream into that page even after a long idle period.
      if (this.isRunning() || this.listeners.length > 0) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, 10 * 60 * 1000);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // Pi normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onDestroy(cb: () => void | Promise<void>): void {
    this.onDestroyCallback = cb;
  }

  /** Allocate one monotonic run identity, optionally checking a caller's expected epoch.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private allocateRun(command: Record<string, unknown>): { runId: string; runEpoch: number } {
    if (this.activeRunId !== null) throw new Error("Another prompt run is already active");
    const runId = typeof command.runId === "string" && command.runId.trim()
      ? command.runId
      : randomUUID();
    const runEpoch = this.runEpoch + 1;
    if (
      command.runEpoch !== undefined
      && (!Number.isSafeInteger(command.runEpoch) || command.runEpoch !== runEpoch)
    ) {
      throw new Error(`Prompt run epoch changed; expected ${runEpoch}`);
    }
    this.runEpoch = runEpoch;
    this.activeRunId = runId;
    this.activeRunEpoch = runEpoch;
    return { runId, runEpoch };
  }

  /** Begin one atomic prompt-and-wait run and retain its exact completion promise.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  private async beginPrompt(command: Record<string, unknown>): Promise<PromptRunHandle> {
    if (this.inner.isBashRunning) throw new Error("Cannot send a prompt while a shell command is running");
    await this.ensureSessionLease?.();
    const identity = this.allocateRun(command);
    const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
    const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
    this.promptRunning = true;
    notifyRunningChange();

    let innerCompletion: Promise<void>;
    try {
      innerCompletion = this.inner.prompt(command.message as string, {
        ...(promptImages?.length ? { images: promptImages } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
        source: "rpc",
      });
    } catch (error) {
      this.promptRunning = false;
      this.clearActiveRun(identity.runId, identity.runEpoch);
      notifyRunningChange();
      throw error;
    }

    const completion = innerCompletion
      .catch((error) => {
        invalidateSessionListCache();
        this.emit(this.withRunIdentity({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        }));
        throw error;
      })
      .finally(async () => {
        await this.ensureSessionLease?.().catch((error) => {
          this.emit(this.withRunIdentity({
            type: "prompt_error",
            errorMessage: `Session lease failed: ${error instanceof Error ? error.message : String(error)}`,
          }));
        });
        this.promptRunning = false;
        if (this.promptCompletion === completion) this.promptCompletion = null;
        if (!streamingBehavior) this.emit(this.withRunIdentity({ type: "prompt_done" }));
        this.clearActiveRun(identity.runId, identity.runEpoch);
        notifyRunningChange();
      });
    this.promptCompletion = completion;
    return { ...identity, completion };
  }

  /** Start a browser prompt without blocking its HTTP request after acceptance.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  private async startPrompt(command: Record<string, unknown>): Promise<{ runId: string; runEpoch: number }> {
    const run = await this.beginPrompt(command);
    void run.completion.catch(() => {
      // Error details are emitted to SSE by beginPrompt().
    });
    return { runId: run.runId, runEpoch: run.runEpoch };
  }

  /** Reject completed worker turns whose final assistant message failed or aborted.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private assertLastAssistantSucceeded(): void {
    for (let index = this.inner.messages.length - 1; index >= 0; index--) {
      const message = this.inner.messages[index];
      if (message.role !== "assistant") continue;
      if (message.stopReason === "error") throw new Error(message.errorMessage || "Worker model failed");
      if (message.stopReason === "aborted") throw new Error("Worker prompt was aborted");
      return;
    }
    throw new Error("Worker completed without an assistant response");
  }

  /** Read bounded usage from the terminal assistant message of the current run.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private getLastAssistantUsage(): { inputTokens: number; outputTokens: number; costUsd?: number } | undefined {
    for (let index = this.inner.messages.length - 1; index >= 0; index--) {
      const message = this.inner.messages[index];
      if (message.role !== "assistant" || !message.usage) continue;
      return {
        inputTokens: message.usage.input ?? 0,
        outputTokens: message.usage.output ?? 0,
        costUsd: message.usage.cost?.total,
      };
    }
    return undefined;
  }

  /** Resolve and apply one model without recursively re-entering command admission.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private async setModel(provider: string, modelId: string): Promise<{ id: string; provider: string }> {
    let model = this.inner.modelRuntime.getModel(provider, modelId);
    if (!model) {
      await this.inner.modelRuntime.refresh({ allowNetwork: false });
      model = this.inner.modelRuntime.getModel(provider, modelId);
    }
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await this.inner.setModel(model);
    invalidateModelsCache();
    invalidateSessionListCache();
    return { id: model.id, provider: model.provider };
  }

  /** Calculate an endpoint fingerprint only for a complete registered model.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private endpointFingerprint(model: AgentSessionLike["model"]): string | undefined {
    if (!model || typeof model.baseUrl !== "string" || typeof model.api !== "string") return undefined;
    return createModelEndpointFingerprint(model);
  }

  /** Apply one Thinking level while preserving DeepSeek's xhigh compatibility.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private setThinkingLevel(level: string): void {
    this.inner.setThinkingLevel(level);
    if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
      this.inner.agent.state.thinkingLevel = "xhigh";
    }
    invalidateSessionListCache();
  }

  /** Reject changes that conflict with a durable worker or peer policy.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  private assertRuntimeSettings(settings: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    toolNames?: string[];
    endpointFingerprint?: string;
  }): void {
    const policy = this.runtimePolicy;
    if (!policy) return;
    const label = policy.kind === "peer" ? "peer Session" : "orchestrated worker";
    if (settings.modelProvider || settings.modelId) {
      if (
        !policy.model
        || settings.modelProvider !== policy.model.provider
        || settings.modelId !== policy.model.modelId
      ) {
        throw new Error(`A ${label}'s model cannot be changed`);
      }
    }
    if (
      settings.thinkingLevel
      && settings.thinkingLevel !== "auto"
      && policy.thinkingLevel
      && settings.thinkingLevel !== policy.thinkingLevel
    ) {
      throw new Error(`A ${label}'s Thinking level cannot be changed`);
    }
    if (settings.toolNames !== undefined) {
      const requested = [...new Set(settings.toolNames)].sort();
      const allowed = [...new Set(policy.toolNames)].sort();
      if (requested.length !== allowed.length || requested.some((name, index) => name !== allowed[index])) {
        throw new Error(`A ${label}'s tool policy cannot be changed`);
      }
    }
    if (
      settings.endpointFingerprint
      && policy.endpointFingerprint
      && settings.endpointFingerprint !== policy.endpointFingerprint
    ) {
      throw new Error(`A ${label}'s endpoint authorization cannot be changed`);
    }
  }

  /** Reapply persisted restrictions immediately before every model turn.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  private async applyRuntimePolicy(): Promise<void> {
    const policy = this.runtimePolicy;
    if (!policy) return;
    if (
      policy.model
      && (this.inner.model?.provider !== policy.model.provider || this.inner.model?.id !== policy.model.modelId)
    ) {
      await this.setModel(policy.model.provider, policy.model.modelId);
    }
    if (policy.model && policy.endpointFingerprint && this.inner.model) {
      const fingerprint = this.endpointFingerprint(this.inner.model);
      if (fingerprint !== policy.endpointFingerprint) {
        throw new Error(`Model endpoint authorization changed for ${policy.model.provider}/${policy.model.modelId}`);
      }
    }
    if (policy.thinkingLevel && this.inner.agent.state?.thinkingLevel !== policy.thinkingLevel) {
      this.setThinkingLevel(policy.thinkingLevel);
    }
    this.inner.setActiveToolsByName(policy.toolNames);
    this.setForceEmptySystemPrompt(false);
  }

  /** Atomically apply exact model, endpoint, Thinking, and tool policy before a run.
   *
   * @author GPT-5.6 Sol
   * @version 2.0.0
   */
  private async applyPromptSettings(settings: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    toolNames?: string[];
    endpointFingerprint?: string;
  }): Promise<void> {
    if (Boolean(settings.modelProvider) !== Boolean(settings.modelId)) {
      throw new Error("Prompt has an incomplete model configuration");
    }
    this.assertRuntimeSettings(settings);
    if (settings.modelProvider && settings.modelId) {
      await this.setModel(settings.modelProvider, settings.modelId);
    }
    if (settings.endpointFingerprint) {
      if (this.endpointFingerprint(this.inner.model) !== settings.endpointFingerprint) {
        throw new Error("Prompt endpoint authorization does not match the active model");
      }
    }
    if (settings.thinkingLevel && settings.thinkingLevel !== "auto") {
      this.setThinkingLevel(settings.thinkingLevel);
    }
    if (settings.toolNames !== undefined) this.inner.setActiveToolsByName([...new Set(settings.toolNames)]);
    await this.applyRuntimePolicy();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this._alive || this.deletionReserved) throw new Error("Session runtime is closed or being deleted");
    this.resetIdleTimer();
    const type = command.type as string;
    const reservesRunAdmission = (type === "prompt" && this.runtimePolicy !== undefined)
      || type === "scheduled_prompt"
      || type === "orchestrated_prompt"
      || type === "peer_prompt_and_wait"
      || type === "compact"
      || type === "bash";
    if (reservesRunAdmission) {
      if (this.isRunning()) throw new Error("Cannot start another run while the session is busy");
      this.pendingRunAdmissions++;
      notifyRunningChange();
    }
    try {
      if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
      if (!this._alive || this.deletionReserved) {
        throw new Error("Session runtime was closed or reserved for deletion before the command started");
      }
      await this.ensureSessionLease?.();
    } catch (error) {
      if (reservesRunAdmission) {
        this.pendingRunAdmissions--;
        notifyRunningChange();
      }
      throw error;
    }
    if (reservesRunAdmission) {
      this.pendingRunAdmissions--;
      notifyRunningChange();
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        // Worker and peer runtimes stay strictly serialized under their
        // persisted policy. Ordinary browser sessions retain Pi 0.84's
        // preflight admission and streaming queue behavior below.
        if (this.runtimePolicy) {
          if (this.isRunning()) throw new Error("Cannot send a prompt while the session is busy");
          this.scheduledPromptStarting = true;
          notifyRunningChange();
          try {
            await this.applyRuntimePolicy();
            return await this.startPrompt(command);
          } finally {
            this.scheduledPromptStarting = false;
            notifyRunningChange();
          }
        }

        const releaseAdmission = await this.acquirePromptAdmission();
        try {
          if (this.inner.isBashRunning) {
            throw new Error("Cannot send a prompt while a shell command is running");
          }
          const promptImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
          const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
          const startsPrimaryRun = !streamingBehavior && this.activeRunId === null;
          const identity = startsPrimaryRun
            ? this.allocateRun(command)
            : {
                runId: this.activeRunId ?? (typeof command.runId === "string" ? command.runId : randomUUID()),
                runEpoch: this.activeRunEpoch ?? this.runEpoch,
              };
          if (startsPrimaryRun) this.promptRunning = true;

          let preflightAccepted = false;
          let preflightSettled = false;
          let promptSettled = false;
          let acceptPreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolvePreflight, reject) => {
            acceptPreflight = () => {
              preflightAccepted = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolvePreflight();
            };
            rejectPreflight = (error) => {
              if (preflightSettled) return;
              preflightSettled = true;
              reject(error);
            };
          });
          const finishPrompt = () => {
            if (promptSettled) return;
            promptSettled = true;
            this.pendingPromptCount = Math.max(0, this.pendingPromptCount - 1);
            this.resetIdleTimer();
            notifyRunningChange();
          };

          this.pendingPromptCount += 1;
          notifyRunningChange();
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              preflightResult: (success) => {
                if (success) acceptPreflight();
              },
            });
          } catch (error) {
            finishPrompt();
            if (startsPrimaryRun) {
              this.promptRunning = false;
              this.clearActiveRun(identity.runId, identity.runEpoch);
            }
            throw error;
          }

          void prompt.then(() => {
            acceptPreflight();
            finishPrompt();
            if (!streamingBehavior) {
              this.promptRunning = false;
              this.emit(this.withRunIdentity({ type: "prompt_done" }));
              this.clearActiveRun(identity.runId, identity.runEpoch);
              notifyRunningChange();
            }
          }, (error) => {
            rejectPreflight(error);
            finishPrompt();
            invalidateSessionListCache();
            if (startsPrimaryRun && !preflightAccepted) {
              this.promptRunning = false;
              this.clearActiveRun(identity.runId, identity.runEpoch);
              notifyRunningChange();
            }
            if (preflightAccepted) {
              this.emit(this.withRunIdentity({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              }));
              if (!streamingBehavior) {
                this.promptRunning = false;
                this.emit(this.withRunIdentity({ type: "prompt_done" }));
                this.clearActiveRun(identity.runId, identity.runEpoch);
                notifyRunningChange();
              }
            }
          }).catch((error) => {
            console.error(
              "[pi-web] prompt completion handler failed:",
              error instanceof Error ? error.message : error,
            );
          });

          await preflight;
          return identity;
        } finally {
          releaseAdmission();
        }
      }

      case "scheduled_prompt": {
        if (this.isRunning()) throw new Error("Cannot start a scheduled prompt while the session is busy");
        if (this.isOrchestratedWorker()) throw new Error("Orchestrated workers cannot receive schedules");
        const settings = command as {
          message: string;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: string;
          toolNames?: string[];
          endpointFingerprint?: string;
          runId?: string;
          runEpoch?: number;
        };
        this.scheduledPromptStarting = true;
        notifyRunningChange();
        try {
          await this.applyPromptSettings(settings);
          const run = await this.beginPrompt({ ...settings, type: "prompt" });
          await run.completion;
          this.assertLastAssistantSucceeded();
          return {
            text: this.inner.getLastAssistantText() ?? "",
            runId: run.runId,
            runEpoch: run.runEpoch,
            usage: this.getLastAssistantUsage(),
          };
        } finally {
          this.scheduledPromptStarting = false;
          notifyRunningChange();
        }
      }

      case "orchestrated_prompt":
      case "peer_prompt_and_wait": {
        const peerPrompt = type === "peer_prompt_and_wait";
        if (this.isRunning()) throw new Error("Cannot prompt the Session while it is busy");
        if (peerPrompt && !this.isPeerSession()) throw new Error("Target is not a durable peer Session");
        const settings = command as {
          message: string;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: string;
          toolNames?: string[];
          endpointFingerprint?: string;
          runId?: string;
          runEpoch?: number;
        };
        this.scheduledPromptStarting = true;
        notifyRunningChange();
        try {
          await this.applyPromptSettings(settings);
          const run = await this.beginPrompt({ ...settings, type: "prompt" });
          await run.completion;
          this.assertLastAssistantSucceeded();
          return {
            text: this.inner.getLastAssistantText() ?? "",
            runId: run.runId,
            runEpoch: run.runEpoch,
            usage: this.getLastAssistantUsage(),
          };
        } finally {
          this.scheduledPromptStarting = false;
          notifyRunningChange();
        }
      }

      case "cancel_run": {
        const runId = command.runId;
        const runEpoch = command.runEpoch;
        if (
          typeof runId !== "string"
          || !Number.isSafeInteger(runEpoch)
          || runId !== this.activeRunId
          || runEpoch !== this.activeRunEpoch
        ) {
          return { cancelled: false };
        }
        await this.withFinalRunningNotification(() => this.inner.abort());
        return { cancelled: true };
      }

      case "abort":
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          runtimeInstanceId: getRpcRuntimeInstanceId(),
          runEpoch: this.runEpoch,
          runId: this.activeRunId,
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning || this.scheduledPromptStarting || this.pendingPromptCount > 0,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          endpointFingerprint: this.endpointFingerprint(model),
          activeToolNames: [...this.inner.getActiveToolNames()],
          messageCount: 0,
          pendingMessageCount: this.inner.pendingMessageCount,
          queuedMessages: {
            steering: [...this.inner.getSteeringMessages()],
            followUp: [...this.inner.getFollowUpMessages()],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: this.inner.agent.state?.systemPrompt ?? "",
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        if (this.isRunning()) throw new Error("Cannot change model while the session is busy");
        const { provider, modelId } = command as { provider: string; modelId: string };
        this.assertRuntimeSettings({ modelProvider: provider, modelId });
        return this.setModel(provider, modelId);
      }

      case "fork": {
        if (this.isOrchestratedWorker()) {
          throw new Error("Orchestrated workers cannot be forked through the generic Session API");
        }
        if (this.isRunning()) {
          throw new Error("Cannot fork while the session is busy");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;

        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          newManager.newSession({ parentSession: currentSessionFile });
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = SessionManager.open(newSessionFile, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await this.shutdown();
        return { cancelled: false, newSessionId };
      }

      case "navigate_tree": {
        if (this.isRunning()) throw new Error("Cannot navigate while the session is busy");
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        if (this.isRunning()) throw new Error("Cannot change Thinking level while the session is busy");
        const level = command.level as string;
        this.assertRuntimeSettings({ thinkingLevel: level });
        this.setThinkingLevel(level);
        return null;
      }

      case "compact": {
        if (this.isRunning()) throw new Error("Cannot compact while the session is busy");
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        if (typeof command.name !== "string") throw new Error("Session name must be a string");
        const name = command.name.trim();
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "close_session": {
        if (this.isRunning()) throw new Error("Cannot close a Session while it is busy");
        await this.shutdown();
        return null;
      }

      case "persist_session": {
        if (this.isRunning()) throw new Error("Cannot persist an empty session while it is busy");
        const sessionFile = this.inner.sessionManager.persistSession();
        if (!sessionFile) throw new Error("Session persistence is disabled");
        cacheSessionPath(this.inner.sessionId, sessionFile);
        invalidateSessionListCache();
        await this.ensureSessionLease?.();
        return { sessionFile };
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "get_schedule_policy": {
        const requested = command as { modelProvider?: string; modelId?: string; thinkingLevel?: string };
        if (Boolean(requested.modelProvider) !== Boolean(requested.modelId)) {
          throw new Error("Schedule model selection is incomplete");
        }
        this.assertRuntimeSettings({
          modelProvider: requested.modelProvider,
          modelId: requested.modelId,
          thinkingLevel: requested.thinkingLevel,
        });
        const selectedModel = requested.modelProvider && requested.modelId
          ? this.inner.modelRuntime.getModel(requested.modelProvider, requested.modelId)
          : this.inner.model;
        if (requested.modelProvider && requested.modelId && !selectedModel) {
          throw new Error(`Model not found: ${requested.modelProvider}/${requested.modelId}`);
        }
        return {
          version: 1,
          toolNames: [...(this.runtimePolicy?.toolNames ?? this.inner.getActiveToolNames())],
          model: selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.id } : undefined,
          thinkingLevel: requested.thinkingLevel && requested.thinkingLevel !== "auto"
            ? requested.thinkingLevel
            : (this.runtimePolicy?.thinkingLevel ?? this.inner.agent.state?.thinkingLevel ?? "off"),
          endpointFingerprint: this.endpointFingerprint(selectedModel),
        };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: pi has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        if (this.scheduledPromptStarting) {
          throw new Error("Cannot steer a scheduled or orchestrated prompt");
        }
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        if (this.scheduledPromptStarting) {
          throw new Error("Cannot queue a follow-up for a scheduled or orchestrated prompt");
        }
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const all: ToolInfo[] = this.inner.getAllTools();
        const active = new Set<string>(this.inner.getActiveToolNames());
        return all.map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        const commands: SlashCommandInfo[] = [];
        for (const registered of this.inner.extensionRunner.getRegisteredCommands()) {
          commands.push({
            name: registered.invocationName,
            description: registered.description,
            source: "extension",
            sourceInfo: registered.sourceInfo,
          });
        }
        for (const template of this.inner.promptTemplates) {
          commands.push({
            name: template.name,
            description: template.description,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }
        for (const skill of this.inner.resourceLoader.getSkills().skills) {
          commands.push({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }
        return { commands };
      }

      case "set_tools": {
        if (this.isRunning()) throw new Error("Cannot change tools while the session is busy");
        const toolNames = command.toolNames as string[];
        this.assertRuntimeSettings({ toolNames });
        if (this.runtimePolicy) {
          this.setForceEmptySystemPrompt(false);
          this.inner.setActiveToolsByName(this.runtimePolicy.toolNames);
        } else {
          this.setForceEmptySystemPrompt(toolNames.length === 0);
          this.inner.setActiveToolsByName(withExtensionTools(this.inner, toolNames));
        }
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "set_tools_exact": {
        if (this.isRunning()) throw new Error("Cannot change tools while the session is busy");
        const toolNames = command.toolNames as string[];
        this.assertRuntimeSettings({ toolNames });
        const forceEmpty = !this.runtimePolicy
          && toolNames.length === 0
          && command.preserveSystemPrompt !== true;
        this.setForceEmptySystemPrompt(forceEmpty);
        this.inner.setActiveToolsByName(this.runtimePolicy?.toolNames ?? toolNames);
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        if (this.isRunning()) throw new Error("Cannot reload while the session is busy");
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        await this.applyRuntimePolicy();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.runtimePolicy && !this.runtimePolicy.toolNames.includes("bash")) {
          throw new Error("This persisted runtime policy does not allow shell commands");
        }
        if (
          this.scheduledPromptStarting
          || this.promptRunning
          || this.pendingPromptCount > 0
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning
        ) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          {
            excludeFromContext: command.excludeFromContext as boolean | undefined,
            operations: createProjectCommandBashOperations({
              shellPath: this.inner.settingsManager.getShellPath(),
            }),
          },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.clearExtensionWidgets(false);
    try {
      this.inner.dispose?.();
    } finally {
      this.destroyCompletion = (async () => {
        await this.inner.waitForRuntimeCleanup?.();
        await this.onDestroyCallback?.();
      })().catch(() => {
        // Registry/lease cleanup is best-effort during process shutdown.
      });
      notifyRunningChange();
    }
  }

  /** Atomically close only a still-empty wrapper with no admitted or active work.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async shutdownIfIdleAndEmpty(): Promise<boolean> {
    if (!this.reserveDeletion()) return false;
    try {
      const hasRuntimeMessages = this.inner.messages.length > 0;
      const hasPersistedMessages = this.inner.sessionManager.getBranch().some((entry) => entry.type === "message");
      if (hasRuntimeMessages || hasPersistedMessages) return false;
      await this.shutdown();
      return true;
    } finally {
      if (this._alive) this.releaseDeletionReservation();
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        await this.inner.extensionRunner.emit?.({ type: "session_shutdown", reason: "quit" });
      } finally {
        this.destroy();
        await this.destroyCompletion;
      }
    })();
    return this.shutdownPromise;
  }

  /** Destroy an idle wrapper and wait for registry/lease cleanup before unlinking its file.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async destroyAndWait(): Promise<void> {
    this.destroy();
    await this.destroyCompletion;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private nextExtensionWidgetGeneration(key: string): number {
    const generation = (this.extensionWidgetGenerations.get(key) ?? 0) + 1;
    this.extensionWidgetGenerations.set(key, generation);
    return generation;
  }

  private disposeExtensionWidgetComponent(component: unknown): void {
    if (!component || (typeof component !== "object" && typeof component !== "function")) return;
    const dispose = (component as { dispose?: unknown }).dispose;
    if (typeof dispose !== "function") return;
    try {
      dispose.call(component);
    } catch {
      // Ignore dispose errors from extension widgets.
    }
  }

  private emitExtensionWidgetClear(key: string): void {
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: key,
      widgetLines: undefined,
      widgetPlacement: undefined,
    } as ExtensionUiRequest as AgentEvent);
  }

  private clearExtensionWidget(key: string, emitClear = true): number {
    const generation = this.nextExtensionWidgetGeneration(key);

    const active = this.activeExtensionWidgets.get(key);
    this.activeExtensionWidgets.delete(key);
    this.extensionWidgets.delete(key);
    if (active) this.disposeExtensionWidgetComponent(active.component);
    if (this.extensionWidgetGenerations.get(key) !== generation) return generation;
    if (emitClear) this.emitExtensionWidgetClear(key);
    return generation;
  }

  private clearExtensionWidgets(emitClear: boolean): void {
    const keys = new Set([
      ...this.extensionWidgets.keys(),
      ...this.activeExtensionWidgets.keys(),
    ]);
    for (const key of keys) this.clearExtensionWidget(key, emitClear);
  }

  private resetExtensionWidgetsForReload(): void {
    this.extensionWidgetsResetting = true;
    try {
      const factoryKeys = [...this.activeExtensionWidgets.keys()];
      for (const key of factoryKeys) this.clearExtensionWidget(key);
      // Keep the existing array-widget reload behavior: snapshots are reset and
      // the next extension session_start repopulates them.
      this.extensionWidgets.clear();
    } finally {
      this.extensionWidgetsResetting = false;
    }
  }

  private emitExtensionWidgetError(key: string, error: unknown): void {
    this.emit({
      type: "extension_error",
      extensionPath: `extension-widget:${key}`,
      event: "setWidget",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private failExtensionWidget(
    key: string,
    generation: number,
    error: unknown,
    clearEmitted: boolean,
    component?: unknown,
  ): void {
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }

    const active = this.activeExtensionWidgets.get(key);
    let shouldEmitClear = !clearEmitted;
    if (active?.generation === generation) {
      shouldEmitClear = active.rendered || !active.clearEmitted;
      this.activeExtensionWidgets.delete(key);
      this.disposeExtensionWidgetComponent(active.component);
    } else {
      this.disposeExtensionWidgetComponent(component);
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.emitExtensionWidgetError(key, error);
      return;
    }
    this.extensionWidgets.delete(key);
    if (shouldEmitClear) this.emitExtensionWidgetClear(key);
    this.emitExtensionWidgetError(key, error);
  }

  private renderExtensionWidget(active: ActiveExtensionWidget): void {
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    let lines: unknown;
    try {
      lines = active.component.render(DEFAULT_CUSTOM_UI_COLUMNS);
    } catch (error) {
      this.failExtensionWidget(active.key, active.generation, error, active.clearEmitted);
      return;
    }
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
      this.failExtensionWidget(
        active.key,
        active.generation,
        new Error("Extension widget render must return string[]"),
        active.clearEmitted,
      );
      return;
    }
    if (
      this.activeExtensionWidgets.get(active.key) !== active
      || this.extensionWidgetGenerations.get(active.key) !== active.generation
    ) return;

    const widgetLines = lines as string[];
    this.extensionWidgets.set(active.key, {
      key: active.key,
      lines: widgetLines,
      placement: active.placement,
    });
    active.rendered = true;
    this.emit({
      type: "extension_ui_request",
      id: randomUUID(),
      method: "setWidget",
      widgetKey: active.key,
      widgetLines,
      widgetPlacement: active.placement,
    } as ExtensionUiRequest as AgentEvent);
  }

  private setExtensionWidgetFactory(
    key: string,
    factory: ExtensionWidgetFactory,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void {
    const hadPrevious = this.extensionWidgets.has(key) || this.activeExtensionWidgets.has(key);
    const generation = this.clearExtensionWidget(key, hadPrevious);
    if (this.extensionWidgetGenerations.get(key) !== generation) return;
    const tui = createHeadlessCustomUiTui(() => {
      const active = this.activeExtensionWidgets.get(key);
      if (active?.generation === generation) this.renderExtensionWidget(active);
    }, DEFAULT_CUSTOM_UI_COLUMNS);

    let component: unknown;
    try {
      component = factory(tui, PLAIN_TEXT_THEME);
    } catch (error) {
      this.failExtensionWidget(key, generation, error, hadPrevious);
      return;
    }
    if (this.extensionWidgetGenerations.get(key) !== generation) {
      this.disposeExtensionWidgetComponent(component);
      return;
    }
    if (
      !component
      || (typeof component !== "object" && typeof component !== "function")
      || typeof (component as { render?: unknown }).render !== "function"
    ) {
      this.failExtensionWidget(
        key,
        generation,
        new Error("Extension widget factory must return a component with render(width)"),
        hadPrevious,
        component,
      );
      return;
    }

    const active: ActiveExtensionWidget = {
      key,
      component: component as ExtensionWidgetComponent,
      placement: options?.placement ?? "aboveEditor",
      generation,
      clearEmitted: hadPrevious,
      rendered: false,
    };
    this.activeExtensionWidgets.set(key, active);
    this.renderExtensionWidget(active);
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T) => {
        cleanup();
        resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (!this._alive || this.extensionWidgetsResetting) return;
        if (typeof content === "function") {
          this.setExtensionWidgetFactory(
            key,
            content as unknown as ExtensionWidgetFactory,
            options,
          );
          return;
        }
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.clearExtensionWidget(key);
          return;
        }
        const generation = this.activeExtensionWidgets.has(key)
          ? this.clearExtensionWidget(key)
          : this.nextExtensionWidgetGeneration(key);
        if (this.extensionWidgetGenerations.get(key) !== generation) return;
        this.extensionWidgets.set(key, {
          key,
          lines: content,
          placement: options?.placement ?? "aboveEditor",
        });
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in Pi Web extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  private createExtensionCommandContextActions(): ExtensionCommandContextActionsLike {
    return {
      waitForIdle: async () => {
        const agent = this.inner.agent as { waitForIdle?: () => Promise<void> };
        await agent.waitForIdle?.();
      },
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async (targetId, options) => {
        const result = await this.inner.navigateTree(targetId, { summarize: options?.summarize });
        return { cancelled: result.cancelled };
      },
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyForcedEmptySystemPrompt();
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    const policyAllowsTrust = this.runtimePolicy?.kind !== "peer" || this.runtimePolicy.projectTrusted === true;
    this.inner.settingsManager.setProjectTrusted(status.trusted && policyAllowsTrust);
  }
}

// ============================================================================
// Session registry
// ============================================================================

export interface RpcSessionStartResult {
  session: AgentSessionWrapper;
  realSessionId: string;
  /** True only for the caller that actually constructed and registered this wrapper. */
  created: boolean;
}

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<RpcSessionStartResult>> | undefined;
  var __piDeletingSessions: Set<string> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
  var __piRpcRuntimeInstanceId: string | undefined;
}

/** Return one random epoch namespace for the lifetime of this Node process.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function getRpcRuntimeInstanceId(): string {
  globalThis.__piRpcRuntimeInstanceId ??= randomUUID();
  return globalThis.__piRpcRuntimeInstanceId;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const cleanup = () => globalThis.__piSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__piSessions;
}

function getLocks(): Map<string, Promise<RpcSessionStartResult>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function getDeletingSessions(): Set<string> {
  if (!globalThis.__piDeletingSessions) globalThis.__piDeletingSessions = new Set();
  return globalThis.__piDeletingSessions;
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export interface RpcSessionDeletionReservation {
  session?: AgentSessionWrapper;
  release(): void;
}

/** Reserve one idle Session against concurrent startup and command admission.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function reserveRpcSessionDeletion(sessionId: string): RpcSessionDeletionReservation | undefined {
  const deleting = getDeletingSessions();
  if (deleting.has(sessionId) || getLocks().has(sessionId)) return undefined;
  const session = getRegistry().get(sessionId);
  if (session?.isAlive() && !session.reserveDeletion()) return undefined;
  deleting.add(sessionId);
  let released = false;
  return {
    session,
    release: () => {
      if (released) return;
      released = true;
      deleting.delete(sessionId);
      session?.releaseDeletionReservation();
    },
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

let webSessionOrchestrationHost: WebSessionOrchestrationHost | undefined;

/** Read persisted model/Thinking entries without building the full message context.
 *
 * @author Kimi K3
 * @version 1.0.0
 */
function readPersistedStartupSettings(sessionManager: SessionManager): {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
} {
  let model: { provider: string; modelId: string } | undefined;
  let thinkingLevel: ThinkingLevel | undefined;
  for (const entry of sessionManager.getBranch()) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel as ThinkingLevel;
    }
  }
  return { model, thinkingLevel };
}

/** Reuse one Pi-Web orchestration adapter over the hot-reload-safe RPC registry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function getWebSessionOrchestrationHost(): WebSessionOrchestrationHost {
  webSessionOrchestrationHost ??= createWebSessionOrchestrationHost({
    startSession: async (sessionId, sessionFile, cwd, toolNames, ownerCapability) => {
      const { session } = await startRpcSession(sessionId, sessionFile, cwd, {
        toolNames,
        includeExtensionTools: false,
        enableSessionOrchestration: false,
        preserveSystemPromptWithoutTools: true,
        orchestrationOwnerHostCapability: ORCHESTRATION_OWNER_HOST_CAPABILITY,
        orchestrationOwnerCapability: ownerCapability,
      });
      await session.send({ type: "set_tools_exact", toolNames, preserveSystemPrompt: true });
      return session;
    },
    getSession: (sessionId) => getRpcSession(sessionId),
    cacheSessionPath,
    invalidateSessionPath: invalidateSessionPathCache,
    invalidateSessionList: invalidateSessionListCache,
  });
  return webSessionOrchestrationHost;
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      orchestration: header?.orchestration,
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), pi generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: StartRpcSessionOptions = {},
): Promise<RpcSessionStartResult> {
  const { toolNames, initialModel, thinkingLevel } = options;
  const registry = getRegistry();
  const locks = getLocks();
  if (getDeletingSessions().has(sessionId)) {
    throw new Error(`Session ${sessionId} is being deleted`);
  }

  const ownerHostAuthorized = options.orchestrationOwnerHostCapability === ORCHESTRATION_OWNER_HOST_CAPABILITY;
  const peerHostAuthorized = options.peerOwnerHostCapability === PEER_OWNER_HOST_CAPABILITY;
  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    if (existing.isOrchestratedWorker() && !ownerHostAuthorized) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    if (existing.isPeerSession() && !peerHostAuthorized) {
      throw new Error("Peer Sessions can only be started through their owning controller authority");
    }
    if (options.expectedSessionTarget && !existing.matchesSessionTarget(options.expectedSessionTarget)) {
      throw new Error("Live Session wrapper does not match the expected physical identity");
    }
    return { session: existing, realSessionId: sessionId, created: false };
  }

  const inflight = locks.get(sessionId);
  if (inflight) {
    const result = await inflight;
    if (result.session.isOrchestratedWorker() && !ownerHostAuthorized) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    if (result.session.isPeerSession() && !peerHostAuthorized) {
      throw new Error("Peer Sessions can only be started through their owning controller authority");
    }
    if (options.expectedSessionTarget && !result.session.matchesSessionTarget(options.expectedSessionTarget)) {
      throw new Error("Started Session wrapper does not match the expected physical identity");
    }
    return { ...result, created: false };
  }

  let finishStartingSession: () => void = () => undefined;
  const starting = (async () => {
    let sessionManager: SessionManager;
    let startupTarget: Awaited<ReturnType<typeof verifySessionTarget>> | undefined;
    if (sessionFile) {
      if (options.expectedSessionTarget) {
        if (
          options.expectedSessionTarget.sessionId !== sessionId
          || resolve(options.expectedSessionTarget.sessionFile) !== resolve(sessionFile)
        ) {
          throw new Error("Expected Session identity does not match the startup request");
        }
        startupTarget = await verifyStoredSessionTarget(options.expectedSessionTarget);
      } else {
        startupTarget = await verifySessionTarget({ sessionId, sessionFile });
      }
      sessionManager = SessionManager.open(startupTarget.sessionFile, startupTarget.sessionDir);
    } else {
      if (!cwd) throw new Error("cwd is required for a new session");
      sessionManager = SessionManager.create(cwd, undefined);
    }
    const sessionCwd = sessionManager.getCwd();
    finishStartingSession = trackStartingSession(sessionCwd);

    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();
    const header = sessionManager.getHeader();
    const metadata = header?.orchestration;
    if (metadata !== undefined && !isSessionOrchestrationMetadata(metadata)) {
      throw new Error("Orchestrated worker metadata is invalid");
    }
    const orchestrationPolicy: PersistedRuntimePolicy | undefined = isSessionOrchestrationMetadata(metadata)
      ? {
          kind: "orchestration",
          toolNames: getSessionOrchestrationToolNames(metadata.toolProfile),
          model: metadata.model,
          thinkingLevel: metadata.thinkingLevel,
        }
      : undefined;
    const storedPeerAuthority = startupTarget
      ? (await new PeerAuthorityStore(agentDir).read()).authorities.find((entry) => (
          entry.peerTarget.sessionId === startupTarget.sessionId
          && entry.peerTarget.fileKey === startupTarget.fileKey
        ))
      : undefined;
    if (storedPeerAuthority && header?.peer === undefined) {
      throw new Error("Peer Session host authority exists but its Session metadata is missing");
    }
    let peerStartupPolicy: ReturnType<typeof getAuthorizedPeerRuntimePolicy> | undefined;
    if (header?.peer !== undefined) {
      if (!peerHostAuthorized || !startupTarget) {
        throw new Error("Peer Sessions can only be started through their owning controller authority");
      }
      peerStartupPolicy = getAuthorizedPeerRuntimePolicy(options.peerSessionRuntime, startupTarget);
    }
    if (orchestrationPolicy && peerStartupPolicy) {
      throw new Error("A Session cannot be both an orchestrated worker and a peer");
    }
    const runtimePolicy: PersistedRuntimePolicy | undefined = orchestrationPolicy ?? (peerStartupPolicy
      ? { kind: "peer", ...peerStartupPolicy }
      : undefined);
    if (
      orchestrationPolicy
      && !ownerHostAuthorized
    ) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    let orchestrationLease: OrchestratedSessionRuntimeLease | undefined;
    let sessionLease: SessionIdentityLease | undefined;
    let runtimeTarget = startupTarget ? storeSessionTarget(startupTarget) : undefined;
    let sessionIdentityVerified = false;
    let sessionLeasePromise: Promise<void> | undefined;
    let startingWrapper: AgentSessionWrapper | undefined;

    /** Acquire and retain the shared lease once a generic Session file exists.
     *
     * @author GPT-5.6 Sol
     * @version 1.0.0
     */
    const ensureGenericSessionLease = async (): Promise<void> => {
      if (orchestrationPolicy) return;
      if (sessionIdentityVerified) {
        if (runtimeTarget) await verifyStoredSessionTarget(runtimeTarget);
        return;
      }
      if (sessionLeasePromise) return sessionLeasePromise;
      const currentFile = sessionManager.getSessionFile();
      sessionLeasePromise = (async () => {
        if (!sessionLease) {
          if (currentFile && existsSync(currentFile)) {
            const target = runtimeTarget
              ? await verifyStoredSessionTarget(runtimeTarget)
              : await verifySessionTarget({
                  sessionId: sessionManager.getSessionId(),
                  sessionFile: currentFile,
                  sessionDir: sessionManager.getSessionDir(),
                  cwd: sessionManager.getCwd(),
                  rejectOrchestration: true,
                });
            const fileLease = await acquireSessionFileLease(target, "runtime");
            sessionLease = fileLease;
            runtimeTarget = storeSessionTarget(fileLease.target);
            sessionManager = SessionManager.open(fileLease.target.sessionFile, fileLease.target.sessionDir);
            sessionIdentityVerified = true;
            return;
          }
          sessionLease = await acquireSessionIdentityLease(
            sessionManager.getSessionId(),
            sessionManager.getSessionDir(),
            "runtime",
          );
        }
        if (currentFile && existsSync(currentFile)) {
          const target = runtimeTarget
            ? await verifyStoredSessionTarget(runtimeTarget)
            : await verifySessionTarget({
                sessionId: sessionManager.getSessionId(),
                sessionFile: currentFile,
                sessionDir: sessionManager.getSessionDir(),
                cwd: sessionManager.getCwd(),
                rejectOrchestration: true,
              });
          runtimeTarget = storeSessionTarget(target);
          sessionManager = SessionManager.open(target.sessionFile, target.sessionDir);
          sessionIdentityVerified = true;
        }
      })().finally(() => { sessionLeasePromise = undefined; });
      return sessionLeasePromise;
    };

    try {
      if (orchestrationPolicy) {
        orchestrationLease = await acquireOrchestratedSessionRuntimeLease(
          sessionManager,
          options.orchestrationOwnerCapability,
        );
      } else {
        await ensureGenericSessionLease();
      }

      // Persisted worker/peer policy overrides every browser-provided tool option.
      const effectiveToolNames = runtimePolicy?.toolNames ?? toolNames;
      const includeExtensionTools = runtimePolicy ? false : options.includeExtensionTools !== false;
      // Determine which tools to pass based on requested toolNames.
      // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
      let toolsOption: string[] | undefined;
      if (effectiveToolNames !== undefined) {
        // toolNames === [] -> "all off" (an empty allow-list disables every tool).
        // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
        // set allowedToolNames to coding builtins only, which filtered every
        // extension/package-provided tool (e.g. subagents, web access) out of the
        // tool registry — so they were unavailable in Pi Web sessions even though the
        // `pi` CLI keeps them. Leaving the allow-list unset lets the SDK register all
        // tools (and activate extension tools); we narrow the ACTIVE set below.
        toolsOption = effectiveToolNames.length === 0 || !includeExtensionTools ? effectiveToolNames : undefined;
      }

      // Restricted workers never regain orchestration tools; peers keep the
      // bounded peer/orchestration tool surface their durable policy allows.
      const enableSessionOrchestration = !orchestrationPolicy && options.enableSessionOrchestration !== false;
      const peerTrustAllowed = runtimePolicy?.kind === "peer"
        ? runtimePolicy.projectTrusted === true && getProjectTrustStatus(sessionCwd, agentDir).trusted
        : undefined;
      const trustReloadOptions = peerTrustAllowed === false
        ? { resolveProjectTrust: async () => false }
        : projectTrustReloadOptions(sessionCwd, agentDir);
      const settingsManager = peerTrustAllowed === undefined
        ? SettingsManager.create(sessionCwd, agentDir)
        : SettingsManager.create(sessionCwd, agentDir, { projectTrusted: peerTrustAllowed });
      const extensionFactories = [
        ...(enableSessionOrchestration
          ? [{
              name: "session-orchestration",
              factory: createSessionOrchestrationExtension(getWebSessionOrchestrationHost()),
              hidden: true,
            }, {
              name: "peer-session",
              factory: createPeerSessionExtension(createWebPeerSessionHooks({
                agentDir,
                startSession: async (request) => {
                  const started = await startAuthorizedPeerRpcSession(
                    storeSessionTarget(request.target.identity),
                    request.target.runtimeAuthority,
                    { toolNames: request.target.runtimeAuthority.runtime.toolNames },
                  );
                  return { agent: started.session, created: started.created };
                },
                getSession: (targetSessionId) => getRpcSession(targetSessionId),
                invalidateSessionPath: invalidateSessionPathCache,
              })),
              hidden: true,
            }]
          : []),
        createProjectCommandBashExtension({ cwd: sessionCwd, settings: settingsManager }),
      ];
      const resourceLoaderOptions = orchestrationPolicy
        ? { extensionsOverride: isolateOrchestratedSessionExtensions }
        : { extensionFactories, extensionsOverride: preferUserBashExtension };
      const services = await createAgentSessionServices({
        cwd: sessionCwd,
        agentDir,
        settingsManager,
        resourceLoaderOptions,
        ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
      });
      const scope = await resolveVisibleModels(
        services.modelRuntime,
        services.settingsManager.getEnabledModels(),
      );
      const defaultProvider = services.settingsManager.getDefaultProvider();
      const defaultModelId = services.settingsManager.getDefaultModel();
      const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
      // A persisted session's own model/Thinking entries win over the settings default
      // when the caller did not explicitly request a startup model.
      const persistedSettings = hasExistingMessages ? undefined : readPersistedStartupSettings(sessionManager);
      const persistedModel = persistedSettings?.model
        && scope.visible.some(
          (model) => model.provider === persistedSettings.model?.provider && model.id === persistedSettings.model?.modelId,
        )
        ? persistedSettings.model
        : undefined;
      const persistedThinking = persistedSettings?.thinkingLevel;
      const requestedModel = runtimePolicy?.model ?? initialModel ?? persistedModel;
      const requestedThinking = runtimePolicy?.thinkingLevel as ThinkingLevel | undefined ?? thinkingLevel ?? persistedThinking;
      const initial = hasExistingMessages
        ? { scopedModels: [...scope.scopedModels] }
        : selectInitialModelScope(scope, {
          ...(requestedModel ? { requestedModel } : {}),
          ...(defaultProvider && defaultModelId
            ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
            : {}),
          ...(requestedThinking ? { thinkingLevel: requestedThinking } : {}),
        });
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(initial.model ? { model: initial.model } : {}),
        ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(orchestrationPolicy ? { orchestratedWorkerRuntime: orchestrationLease } : {}),
        ...(peerStartupPolicy ? { peerSessionRuntime: options.peerSessionRuntime } : {}),
        ...(!orchestrationPolicy && sessionLease ? { sessionFileRuntime: sessionLease } : {}),
      });

      const persistedPreferences = await persistExplicitStartupPreferences(
        services.settingsManager,
        {
          ...(initialModel ? { model: initialModel } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
        {
          ...(inner.model
            ? { model: { provider: inner.model.provider, modelId: inner.model.id } }
            : {}),
          thinkingLevel: inner.thinkingLevel,
          supportsThinking: inner.supportsThinking(),
        },
      );
      if (persistedPreferences.modelDefaultChanged) invalidateModelsCache();

      if (effectiveToolNames && effectiveToolNames.length > 0) {
        inner.setActiveToolsByName(
          includeExtensionTools ? withExtensionTools(inner, effectiveToolNames) : effectiveToolNames,
        );
      }

      const wrapper = new AgentSessionWrapper(
        inner,
        runtimePolicy,
        undefined,
        ensureGenericSessionLease,
        () => runtimeTarget,
      );
      startingWrapper = wrapper;
      const forceEmptySystemPrompt = !runtimePolicy
        && effectiveToolNames?.length === 0
        && !options.preserveSystemPromptWithoutTools;
      if (forceEmptySystemPrompt) wrapper.setForceEmptySystemPrompt(true);
      wrapper.start();

      if (runtimePolicy?.model) {
        await wrapper.send({
          type: "set_model",
          provider: runtimePolicy.model.provider,
          modelId: runtimePolicy.model.modelId,
        });
      }
      if (runtimePolicy?.thinkingLevel) {
        await wrapper.send({ type: "set_thinking_level", level: runtimePolicy.thinkingLevel });
      }
      if (runtimePolicy) {
        await wrapper.send({
          type: "set_tools_exact",
          toolNames: runtimePolicy.toolNames,
          preserveSystemPrompt: true,
        });
      }

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      wrapper.onDestroy(async () => {
        registry.delete(realSessionId);
        const leases = [orchestrationLease, sessionLease].filter(
          (lease): lease is OrchestratedSessionRuntimeLease | SessionIdentityLease => lease !== undefined,
        );
        orchestrationLease = undefined;
        sessionLease = undefined;
        await Promise.all(leases.map((lease) => lease.release().catch(() => undefined)));
      });
      registry.set(realSessionId, wrapper);
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt });
      return { session: wrapper, realSessionId, created: true };
    } catch (error) {
      startingWrapper?.destroy();
      await orchestrationLease?.release().catch(() => undefined);
      await sessionLease?.release().catch(() => undefined);
      orchestrationLease = undefined;
      sessionLease = undefined;
      throw error;
    }
  })().finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}

/** Start or reuse a peer only after an owner/scheduler path supplies host authority.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function startAuthorizedPeerRpcSession(
  target: StoredSessionTarget,
  peerSessionRuntime: PeerSessionRuntimeAuthority,
  options: Omit<StartRpcSessionOptions, "peerOwnerHostCapability" | "peerSessionRuntime" | "expectedSessionTarget"> = {},
): Promise<RpcSessionStartResult> {
  return startRpcSession(target.sessionId, target.sessionFile, target.cwd, {
    ...options,
    peerOwnerHostCapability: PEER_OWNER_HOST_CAPABILITY,
    peerSessionRuntime,
    expectedSessionTarget: target,
  });
}
