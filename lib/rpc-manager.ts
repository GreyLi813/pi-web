import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  acquireOrchestratedSessionRuntimeLease,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createSessionOrchestrationExtension,
  getAgentDir,
  getSessionOrchestrationToolNames,
  initTheme,
  isolateOrchestratedSessionExtensions,
  isSessionOrchestrationMetadata,
  type OrchestratedSessionRuntimeLease,
  SessionManager,
  type SessionOrchestrationOwnerCapability,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } from "./session-reader";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { persistExplicitStartupPreferences } from "./startup-preferences";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type { ExtensionUiRequest, ExtensionUiResponse, ExtensionWidgetItem } from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";
import {
  installCodexImportProviderProjection,
  readCodexImportRuntimePolicy,
} from "./codex-import/runtime";
import { createWebSessionOrchestrationHost, type WebSessionOrchestrationHost } from "./session-orchestration-host";

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

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const ORCHESTRATION_OWNER_HOST_CAPABILITY = Symbol("orchestration-owner-host");

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
}

export interface OrchestratedRuntimePolicy {
  toolNames: string[];
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
}

const CODING_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
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
  private promptCompletion: Promise<void> | null = null;
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
    private readonly orchestrationPolicy?: OrchestratedRuntimePolicy,
    private readonly startupExactToolNames?: readonly string[],
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
    return this.orchestrationPolicy !== undefined;
  }

  isRunning(): boolean {
    return this._alive && (
      this.scheduledPromptStarting
      || this.promptRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
    );
  }

  start(): void {
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
    });
    this.resetIdleTimer();
    notifyRunningChange();
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
      this.applyStartupExactTools();
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
      || type === "steer"
      || type === "follow_up"
      || type === "get_tools"
      || type === "set_tools"
      || type === "set_tools_exact"
      || type === "get_commands";
  }

  /**
   * Reapply an imported Session's exact initial Pi tool set after extensions register tools.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private applyStartupExactTools(): void {
    if (!this.orchestrationPolicy && this.startupExactToolNames) {
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
    for (const l of this.listeners) l(event);
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

  /** Begin one prompt and retain its completion promise for server-side orchestration.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private beginPrompt(command: Record<string, unknown>): Promise<void> {
    if (this.inner.isBashRunning) {
      throw new Error("Cannot send a prompt while a shell command is running");
    }
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
      notifyRunningChange();
      throw error;
    }

    const completion = innerCompletion
      .catch((error) => {
        invalidateSessionListCache();
        this.emit({
          type: "prompt_error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      })
      .finally(() => {
        this.promptRunning = false;
        if (this.promptCompletion === completion) this.promptCompletion = null;
        if (!streamingBehavior) this.emit({ type: "prompt_done" });
        notifyRunningChange();
      });
    this.promptCompletion = completion;
    return completion;
  }

  /** Start a browser prompt without blocking its HTTP request.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private startPrompt(command: Record<string, unknown>): null {
    void this.beginPrompt(command).catch(() => {
      // Error details are emitted to SSE by beginPrompt().
    });
    return null;
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

  /** Reject attempts to change a worker's durable model, Thinking, or tool profile.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private assertOrchestrationSettings(settings: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
    toolNames?: string[];
  }): void {
    const policy = this.orchestrationPolicy;
    if (!policy) return;
    if (settings.modelProvider || settings.modelId) {
      if (
        !policy.model
        || settings.modelProvider !== policy.model.provider
        || settings.modelId !== policy.model.modelId
      ) {
        throw new Error("An orchestrated worker's model cannot be changed");
      }
    }
    if (
      settings.thinkingLevel
      && settings.thinkingLevel !== "auto"
      && policy.thinkingLevel
      && settings.thinkingLevel !== policy.thinkingLevel
    ) {
      throw new Error("An orchestrated worker's Thinking level cannot be changed");
    }
    if (settings.toolNames) {
      const requested = [...new Set(settings.toolNames)].sort();
      const allowed = [...new Set(policy.toolNames)].sort();
      if (requested.length !== allowed.length || requested.some((name, index) => name !== allowed[index])) {
        throw new Error("An orchestrated worker's tool profile cannot be changed");
      }
    }
  }

  /** Reapply persisted worker restrictions immediately before every model turn.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private async applyOrchestrationPolicy(): Promise<void> {
    const policy = this.orchestrationPolicy;
    if (!policy) return;
    if (
      policy.model
      && (this.inner.model?.provider !== policy.model.provider || this.inner.model?.id !== policy.model.modelId)
    ) {
      await this.setModel(policy.model.provider, policy.model.modelId);
    }
    if (policy.thinkingLevel && this.inner.agent.state?.thinkingLevel !== policy.thinkingLevel) {
      this.setThinkingLevel(policy.thinkingLevel);
    }
    this.inner.setActiveToolsByName(policy.toolNames);
    this.setForceEmptySystemPrompt(false);
  }

  /** Apply an optional model and Thinking configuration before a prompt starts.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  private async applyPromptSettings(settings: {
    modelProvider?: string;
    modelId?: string;
    thinkingLevel?: string;
  }): Promise<void> {
    if (Boolean(settings.modelProvider) !== Boolean(settings.modelId)) {
      throw new Error("Prompt has an incomplete model configuration");
    }
    this.assertOrchestrationSettings(settings);
    if (settings.modelProvider && settings.modelId) {
      await this.setModel(settings.modelProvider, settings.modelId);
    }
    if (settings.thinkingLevel && settings.thinkingLevel !== "auto") {
      this.setThinkingLevel(settings.thinkingLevel);
    }
    await this.applyOrchestrationPolicy();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this._alive || this.deletionReserved) throw new Error("Session runtime is closed or being deleted");
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    if (!this._alive || this.deletionReserved) {
      throw new Error("Session runtime was closed or reserved for deletion before the command started");
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt":
        if (this.isRunning()) {
          throw new Error("Cannot send a prompt while the session is busy");
        }
        this.scheduledPromptStarting = true;
        notifyRunningChange();
        try {
          await this.applyOrchestrationPolicy();
          return this.startPrompt(command);
        } finally {
          this.scheduledPromptStarting = false;
          notifyRunningChange();
        }

      case "scheduled_prompt": {
        if (this.isRunning()) {
          throw new Error("Cannot start a scheduled prompt while the session is busy");
        }
        const settings = command as {
          message: string;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: string;
        };

        this.scheduledPromptStarting = true;
        notifyRunningChange();
        try {
          await this.applyPromptSettings(settings);
          return this.startPrompt({ type: "prompt", message: settings.message });
        } finally {
          this.scheduledPromptStarting = false;
          notifyRunningChange();
        }
      }

      case "orchestrated_prompt": {
        if (this.isRunning()) {
          throw new Error("Cannot prompt an orchestrated session while it is busy");
        }
        const settings = command as {
          message: string;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: string;
        };

        this.scheduledPromptStarting = true;
        notifyRunningChange();
        try {
          await this.applyPromptSettings(settings);
          await this.beginPrompt({ type: "prompt", message: settings.message });
          this.assertLastAssistantSucceeded();
          return { text: this.inner.getLastAssistantText() ?? "" };
        } finally {
          this.scheduledPromptStarting = false;
          notifyRunningChange();
        }
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
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning || this.scheduledPromptStarting,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
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
        this.assertOrchestrationSettings({ modelProvider: provider, modelId });
        return this.setModel(provider, modelId);
      }

      case "fork": {
        if (this.orchestrationPolicy) {
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
        this.assertOrchestrationSettings({ thinkingLevel: level });
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
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        this.inner.setSessionName(name);
        invalidateSessionListCache();
        return null;
      }

      case "persist_session": {
        if (this.isRunning()) throw new Error("Cannot persist an empty session while it is busy");
        const sessionFile = this.inner.sessionManager.persistSession();
        if (!sessionFile) throw new Error("Session persistence is disabled");
        cacheSessionPath(this.inner.sessionId, sessionFile);
        invalidateSessionListCache();
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
        this.assertOrchestrationSettings({ toolNames });
        if (this.orchestrationPolicy) {
          this.setForceEmptySystemPrompt(false);
          this.inner.setActiveToolsByName(this.orchestrationPolicy.toolNames);
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
        this.assertOrchestrationSettings({ toolNames });
        const forceEmpty = !this.orchestrationPolicy
          && toolNames.length === 0
          && command.preserveSystemPrompt !== true;
        this.setForceEmptySystemPrompt(forceEmpty);
        this.inner.setActiveToolsByName(this.orchestrationPolicy?.toolNames ?? toolNames);
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        if (this.isRunning()) throw new Error("Cannot reload while the session is busy");
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        this.syncProjectTrust();
        await this.inner.reload();
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
        this.applyStartupExactTools();
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        await this.applyOrchestrationPolicy();
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
        if (this.orchestrationPolicy && !this.orchestrationPolicy.toolNames.includes("bash")) {
          throw new Error("This orchestrated worker's tool profile does not allow shell commands");
        }
        if (
          this.scheduledPromptStarting
          || this.promptRunning
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning
        ) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
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
    try {
      this.inner.dispose?.();
    } finally {
      this.destroyCompletion = Promise.resolve(this.onDestroyCallback?.()).catch(() => {
        // Registry/lease cleanup is best-effort during process shutdown.
      });
      notifyRunningChange();
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
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
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
        this.extensionWidgets.clear();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
        this.applyStartupExactTools();
        this.applyForcedEmptySystemPrompt();
      },
    };
  }

  private syncProjectTrust(): void {
    const status = getProjectTrustStatus(this.cwd, getAgentDir());
    this.inner.settingsManager.setProjectTrusted(status.trusted);
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __piSessions: Map<string, AgentSessionWrapper> | undefined;
  var __piStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __piDeletingSessions: Set<string> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
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

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
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
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { toolNames, initialModel, thinkingLevel } = options;
  const registry = getRegistry();
  const locks = getLocks();
  if (getDeletingSessions().has(sessionId)) {
    throw new Error(`Session ${sessionId} is being deleted`);
  }

  const ownerHostAuthorized = options.orchestrationOwnerHostCapability === ORCHESTRATION_OWNER_HOST_CAPABILITY;
  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    if (existing.isOrchestratedWorker() && !ownerHostAuthorized) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    return { session: existing, realSessionId: sessionId };
  }

  const inflight = locks.get(sessionId);
  if (inflight) {
    const result = await inflight;
    if (result.session.isOrchestratedWorker() && !ownerHostAuthorized) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    return result;
  }

  let sessionManager: SessionManager;
  if (sessionFile) {
    sessionManager = SessionManager.open(sessionFile, undefined);
  } else {
    if (!cwd) throw new Error("cwd is required for a new session");
    sessionManager = SessionManager.create(cwd, undefined);
  }
  const sessionCwd = sessionManager.getCwd();
  const finishStartingSession = trackStartingSession(sessionCwd);
  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    initTheme();
    const agentDir = getAgentDir();
    const metadata = sessionManager.getHeader()?.orchestration;
    if (metadata !== undefined && !isSessionOrchestrationMetadata(metadata)) {
      throw new Error("Orchestrated worker metadata is invalid");
    }
    const orchestrationPolicy: OrchestratedRuntimePolicy | undefined = isSessionOrchestrationMetadata(metadata)
      ? {
          toolNames: getSessionOrchestrationToolNames(metadata.toolProfile),
          model: metadata.model,
          thinkingLevel: metadata.thinkingLevel,
        }
      : undefined;
    const codexImportPolicy = !orchestrationPolicy && sessionFile
      ? readCodexImportRuntimePolicy(sessionManager.getEntries())
      : undefined;
    if (
      orchestrationPolicy
      && !ownerHostAuthorized
    ) {
      throw new Error("Orchestrated workers can only be started through their owning controller Session");
    }
    let runtimeLease: OrchestratedSessionRuntimeLease | undefined;
    let startingWrapper: AgentSessionWrapper | undefined;

    try {
      if (orchestrationPolicy) {
        runtimeLease = await acquireOrchestratedSessionRuntimeLease(
          sessionManager,
          options.orchestrationOwnerCapability,
        );
      }

      // Persisted worker policy overrides every browser-provided tool option.
      const effectiveToolNames = orchestrationPolicy?.toolNames ?? (codexImportPolicy ? undefined : toolNames);
      const includeExtensionTools = orchestrationPolicy ? false : options.includeExtensionTools !== false;
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

      // Worker runtimes never regain orchestration or discovered extension tools.
      const enableSessionOrchestration = !orchestrationPolicy && options.enableSessionOrchestration !== false;
      const extensionFactories = enableSessionOrchestration
        ? [{
            name: "session-orchestration",
            factory: createSessionOrchestrationExtension(getWebSessionOrchestrationHost()),
            hidden: true,
          }]
        : [];
      const resourceLoaderOptions = orchestrationPolicy
        ? { extensionsOverride: isolateOrchestratedSessionExtensions }
        : (extensionFactories.length > 0 ? { extensionFactories } : undefined);
      // Build services first so extension-registered providers are available
      // before the SDK restores the saved model from the session file.
      // Gate untrusted project extensions so opening a repository does not run
      // its .pi/extensions code automatically (see lib/project-trust.ts, #236).
      const trustReloadOptions = projectTrustReloadOptions(sessionCwd, agentDir);
      const services = await createAgentSessionServices({
        cwd: sessionCwd,
        agentDir,
        ...(resourceLoaderOptions ? { resourceLoaderOptions } : {}),
        ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
      });
      const scope = await resolveVisibleModels(
        services.modelRuntime,
        services.settingsManager.getEnabledModels(),
      );
      const defaultProvider = services.settingsManager.getDefaultProvider();
      const defaultModelId = services.settingsManager.getDefaultModel();
      const hasExistingMessages = sessionManager.getBranch().some((entry) => entry.type === "message");
      const initial = hasExistingMessages
        ? { scopedModels: [...scope.scopedModels] }
        : selectInitialModelScope(scope, {
          ...(initialModel ? { requestedModel: initialModel } : {}),
          ...(defaultProvider && defaultModelId
            ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
            : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(initial.model ? { model: initial.model } : {}),
        ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
        ...(toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(orchestrationPolicy ? { orchestratedWorkerRuntime: runtimeLease } : {}),
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
      if (codexImportPolicy) {
        installCodexImportProviderProjection(inner.agent, codexImportPolicy);
        inner.setActiveToolsByName(codexImportPolicy.initialToolNames);
      }

      const wrapper = new AgentSessionWrapper(
        inner,
        orchestrationPolicy,
        codexImportPolicy?.initialToolNames,
      );
      startingWrapper = wrapper;
      const forceEmptySystemPrompt = !orchestrationPolicy
        && effectiveToolNames?.length === 0
        && !options.preserveSystemPromptWithoutTools;
      if (forceEmptySystemPrompt) wrapper.setForceEmptySystemPrompt(true);
      wrapper.start();

      if (orchestrationPolicy?.model) {
        await wrapper.send({
          type: "set_model",
          provider: orchestrationPolicy.model.provider,
          modelId: orchestrationPolicy.model.modelId,
        });
      }
      if (orchestrationPolicy?.thinkingLevel) {
        await wrapper.send({ type: "set_thinking_level", level: orchestrationPolicy.thinkingLevel });
      }
      if (orchestrationPolicy) {
        await wrapper.send({
          type: "set_tools_exact",
          toolNames: orchestrationPolicy.toolNames,
          preserveSystemPrompt: true,
        });
      }

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      wrapper.onDestroy(async () => {
        registry.delete(realSessionId);
        if (runtimeLease) {
          const lease = runtimeLease;
          runtimeLease = undefined;
          await lease.release().catch(() => {
            // A stale lease cleanup error must not crash the shared web process.
          });
        }
      });
      registry.set(realSessionId, wrapper);
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt });
      return { session: wrapper, realSessionId };
    } catch (error) {
      startingWrapper?.destroy();
      if (runtimeLease) {
        try {
          await runtimeLease.release();
        } catch {
          // Preserve the original startup error.
        }
      }
      throw error;
    }
  })().finally(() => {
    locks.delete(sessionId);
    finishStartingSession();
  });

  locks.set(sessionId, starting);
  return starting;
}
