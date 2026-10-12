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
  type LoadExtensionsResult,
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
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { findDeferredModel, rememberProviderModels } from "./deferred-provider-models";
import { isBlockingExtensionUiRequest } from "./extension-ui-queue";
import {
  cacheSessionPath,
  catalogFirstMessage,
  getLatestModelChange,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readLatestSessionEntryId,
  resolveSessionPath,
} from "./session-reader";
import {
  createProjectCommandBashExtension,
  createProjectCommandBashOperations,
  preferUserBashExtension,
} from "./project-command-env";
import { getProjectTrustStatus, projectTrustReloadOptions } from "./project-trust";
import { notifySessionComplete } from "./web-push";
import { hasActiveSessionLivenessProvider } from "./session-liveness";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike, ExtensionUiContextLike, ToolInfo } from "./pi-types";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS, type HeadlessCustomUiTui } from "./custom-ui-terminal";
import { createWebSessionOrchestrationHost, type WebSessionOrchestrationHost } from "./session-orchestration-host";
import { createWebPeerSessionHooks } from "./peer-session-hooks";
import {
  createSubagentExtension,
  preferPiWebSubagentExtension,
} from "./subagent-extension";
import {
  listSubagentProfiles,
  hasSubagentResourceSnapshot,
  readSubagentRun,
  readSubagentSessionResources,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./subagents";
import { createSubagentController } from "./subagent-runtime";
import { isBuiltInSubagentsEnabled } from "./subagent-settings";
import { resolveShellTools } from "./powershell-settings";
import { CHAT_ONLY_RESOURCE_LOADER_OPTIONS, contextFilesSystemPrompt } from "./chat-only";
import { withTranscriptSystemPrompt } from "./agent-system-prompt";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import { createPiWebBuiltinExtensions, createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { mcpPromptPreparation, type McpCommandCandidate } from "./mcp-command";
import { createReadOnlyMcpPolicyExtension, createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { isNestedToolExecutionEvent } from "./agent-event-wire";
import {
  appendClearedSessionToolSelection,
  appendSessionToolSelection,
  readSessionToolSelection,
  validateSessionToolSelection,
} from "./session-tool-selection";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
/** `sessionName`: the live session's own title (its newest `session_info`), read without a disk scan. */
type AgentRunCompleteListener = (sessionId: string, sessionName: string | undefined) => void;

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

type AgentSessionWrapperOptions = {
  exactSystemPrompt?: () => string;
  chatOnly?: boolean;
  onAgentRunComplete?: AgentRunCompleteListener;
  suppressCompletionNotifications?: boolean;
  /** Connects the session's MCP servers before a prompt starts a run, and lets go of them when it closes (lib/mcp-host.ts). */
  mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  /** Chat only: the extension-provided model the session wanted, named when a prompt finds no model. */
  chatOnlyExtensionModel?: { provider: string; id: string };
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

/**
 * Chat only loads no extensions, so a provider one registers is missing from its runtime (#804).
 * Said instead of "Model not found", or pi's "No API key found" for a session left without a model.
 */
function chatOnlyExtensionModelError(provider: string, modelId: string): Error {
  return new Error(
    `${provider}/${modelId} is provided by an extension, and Chat only loads no extensions. Choose another model or tool preset.`,
  );
}

export const MCP_WAIT_STOPPED_MESSAGE = "Stopped while MCP servers were connecting; the message was not sent.";

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const ORCHESTRATION_OWNER_HOST_CAPABILITY = Symbol("orchestration-owner-host");
const PEER_OWNER_HOST_CAPABILITY = Symbol("peer-owner-host");

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolves the PI_WEB_IDLE_TIMEOUT_MS environment variable into a session idle
 * timeout in milliseconds. An unset/blank value returns the 10-minute default,
 * `0` disables idle shutdown, and positive values up to Node's timer limit
 * (2147483647 ms) are used as-is. Invalid or out-of-range values fall back to
 * the default with a console warning.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionIdleTimeoutMs(
  rawValue: string | undefined = process.env.PI_WEB_IDLE_TIMEOUT_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_IDLE_TIMEOUT_MS "${rawValue}", falling back to 10 minutes`);
  }
  return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

const SESSION_IDLE_TIMEOUT_MS = resolveSessionIdleTimeoutMs();

const DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * Resolves the PI_WEB_SHUTDOWN_DEADLINE_MS environment variable into the time
 * extensions get to handle `session_shutdown` before the wrapper disposes the
 * SDK session anyway. An unset/blank value returns the 5-second default, and
 * positive values up to Node's timer limit (2147483647 ms) are used as-is.
 * `0`, invalid and out-of-range values fall back to the default with a console
 * warning: shutdown always has a deadline.
 * @param rawValue Value to parse; defaults to the environment variable.
 */
export function resolveSessionShutdownDeadlineMs(
  rawValue: string | undefined = process.env.PI_WEB_SHUTDOWN_DEADLINE_MS,
): number {
  if (rawValue !== undefined && rawValue.trim() !== "") {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 2_147_483_647) return parsed;
    console.warn(`[pi-web] invalid PI_WEB_SHUTDOWN_DEADLINE_MS "${rawValue}", falling back to 5 seconds`);
  }
  return DEFAULT_SESSION_SHUTDOWN_DEADLINE_MS;
}

const SESSION_SHUTDOWN_DEADLINE_MS = resolveSessionShutdownDeadlineMs();

const SESSION_REPLACEMENT_COMMAND_TYPES = new Set(["fork", "clone"]);
// pi writes a session file at the first user message, so a session with no
// conversation on disk has nothing to copy from yet.
const UNSAVED_SESSION_FORK_ERROR =
  "This session has not been saved yet. Send a message before forking it.";
const COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT = new Set([
  "get_state",
  "get_session_stats",
  "get_last_assistant_text",
  "get_tools",
  "get_commands",
  "extension_ui_response",
  "extension_ui_input",
]);

export interface StartRpcSessionOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  allowInitialModelFallback?: boolean;
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

const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVEL_NAMES = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as ConstructorParameters<typeof Theme>[0],
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

// Tools that belong to the session, not to a branch of it: the ones that reach other tools,
// and pi-web's subagent tools, which the built-in subagent setting switches on for the whole
// session. Navigation keeps them although the target branch was recorded without them.
const SESSION_TOOL_NAMES = new Set<string>(["codemode", "tool_search", ...SUBAGENT_CONTROL_TOOL_NAMES]);

/**
 * The active tools for a coding tool selection. The selection replaces only the coding
 * tools: every other tool named in `carry` that is still registered and not withdrawn stays
 * active, so a tool an extension, `tool_search`, or `defaultTools` activated survives, and a
 * tool one switched off stays off. Nothing else is added: pi itself activates the extension
 * tools it registers (all of them when it builds or reloads a session, then each new one), so
 * `carry` already holds them. An empty selection is Chat only.
 */
export function resolveActiveToolNames(
  session: AgentSessionLike,
  requested: readonly string[],
  carry: readonly string[],
): string[] {
  if (requested.length === 0) return [];

  const codingToolNames = new Set(CODING_TOOL_NAMES);
  const registered = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  const selectedToolNames = resolveShellTools(
    requested.filter((name) => codingToolNames.has(name)),
    session.settingsManager.getDefaultTools(),
  );
  const carriedToolNames = carry.filter((name) => {
    const tool = registered.get(name);
    return tool !== undefined && !codingToolNames.has(name) && tool.exposure !== "hidden";
  });

  return [...new Set([...selectedToolNames, ...carriedToolNames])];
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  // A Set, not an array: an SSE stream unsubscribes from inside emit() when it
  // closes on session_shutdown, and splicing an array mid-iteration made the
  // next stream miss that same event.
  private listeners = new Set<EventListener>();
  private activeToolEvents = new Map<string, AgentEvent>();
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionUiAbortController = new AbortController();
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
  private activeMutatingCommands = 0;
  private sessionReplacement: "fork" | "clone" | null = null;
  private agentRunNeedsCompletion = false;
  // Whether the last run ended because it was stopped (pi 1.1's `agent_settled.aborted`), not finished.
  private lastRunAborted = false;
  private promptAdmissionTail: Promise<void> = Promise.resolve();
  private runEpoch = 0;
  private activeRunId: string | null = null;
  private activeRunEpoch: number | null = null;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private readonly exactSystemPrompt?: () => string;
  private readonly chatOnly: boolean;
  private readonly onAgentRunComplete?: AgentRunCompleteListener;
  private readonly suppressCompletionNotifications: boolean;
  private readonly mcpHost?: Pick<McpHost, "prepareForPrompt" | "dispose">;
  private readonly chatOnlyExtensionModel?: { provider: string; id: string };
  private mcpHostDisposed = false;
  // The MCP wait of the prompt being admitted; Stop ends it.
  private mcpPromptWait: { controller: AbortController; done: Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void | Promise<void>) | null = null;
  private destroyCompletion: Promise<void> | null = null;
  private deletionReserved = false;
  private shutdownPromise: Promise<void> | null = null;
  private sessionShutdownEmitted = false;
  private forceShutdownOnIdle = false;
  // The armed idle timer is the forced cleanup Stop scheduled.
  private forcedIdleTimerArmed = false;
  private _alive = true;
  private resolveDisposed: () => void = () => {};
  private readonly disposed = new Promise<void>((resolve) => { this.resolveDisposed = resolve; });
  // Set when shutdown() starts. The SDK session stays usable until destroy(),
  // but lookups must treat the wrapper as gone from this point on.
  private closing = false;

  constructor(
    public readonly inner: AgentSessionLike,
    private readonly runtimePolicy?: PersistedRuntimePolicy,
    private readonly startupExactToolNames?: readonly string[],
    private readonly ensureSessionLease?: () => Promise<void>,
    private readonly runtimeTarget?: StoredSessionTarget | (() => StoredSessionTarget | undefined),
    options: AgentSessionWrapperOptions = {},
  ) {
    this.exactSystemPrompt = options.exactSystemPrompt;
    this.chatOnly = options.chatOnly ?? false;
    this.onAgentRunComplete = options.onAgentRunComplete;
    this.suppressCompletionNotifications = options.suppressCompletionNotifications ?? false;
    this.mcpHost = options.mcpHost;
    this.chatOnlyExtensionModel = options.chatOnlyExtensionModel;
    // An exact system prompt reaches the model through the inline `before_agent_start`
    // handler (lib/exact-system-prompt.ts) that the session's resource loader registers,
    // and the transcript keeps recording Pi's structured sections. Since Pi 0.86 the
    // SDK prompt state is a getter replayed from those messages, so the wrapper must
    // neither assign it nor patch the agent's turn hooks.
  }

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

  /**
   * False from the moment shutdown() or destroy() begins, not only once the SDK
   * session is disposed: extensions may take up to the shutdown deadline to
   * handle session_shutdown, and a prompt routed here meanwhile would be lost.
   */
  isAlive(): boolean {
    return this._alive && !this.closing;
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

  /**
   * True while an extension's blocking dialog is unanswered: select, confirm,
   * input, editor, or a custom overlay still open. The run is parked on a promise
   * only the user can settle, so the sidebar shows awaiting input rather than the
   * running spinner. Never true for an idle session: a custom overlay that
   * outlives its turn is not a parked run.
   */
  isAwaitingInput(): boolean {
    if (!this.isRunning()) return false;
    for (const request of this.pendingUiRequests.values()) {
      if (isBlockingExtensionUiRequest(request as unknown as ExtensionUiRequest)) return true;
    }
    return false;
  }

  /**
   * Drop this idle wrapper when the on-disk JSONL has an entry the in-memory
   * index never saw (another pi process appended). Rechecks isRunning() so a
   * prompt that started during the probe cannot be disposed.
   */
  evictIfDiskAhead(): boolean {
    if (!this.isAlive() || this.isRunning()) return false;
    const diskLatestId = readLatestSessionEntryId(this.sessionFile);
    if (!diskLatestId || this.inner.sessionManager.getEntry(diskLatestId)) return false;
    if (this.isRunning()) return false;
    this.destroy();
    invalidateSessionListCache();
    return true;
  }

  isChatOnly(): boolean {
    return this.chatOnly;
  }

  hasSuppressedCompletionNotifications(): boolean {
    return this.suppressCompletionNotifications;
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
      if (event.type === "agent_start") {
        this.agentRunNeedsCompletion = true;
        this.lastRunAborted = false;
      }
      if (event.type === "agent_settled") this.lastRunAborted = event.aborted === true;
      if (event.type === "agent_end") {
        invalidateSessionListCache();
        // Every tool call of the run has finished; nothing is left to replay.
        this.activeToolEvents.clear();
      }
      this.trackActiveToolEvent(event);
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(this.withRunIdentity(event));
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
      if (event.type === "agent_settled" && this.promptCompletion === null) this.clearActiveRun();
      if (event.type === "agent_settled") this.notifyAgentRunCompleteIfIdle();
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

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.messages = withTranscriptSystemPrompt(this.inner.agent.state.messages, "");
    }
  }

  /**
   * Keep the latest start or update of each running tool call for onEvent() to
   * replay. Calls a tool makes itself (a codemode script's, which carry
   * `parentToolCallId`) are left out: a reconnecting client would show each as a
   * top-level tool, and the parent's own update already reports them. A nested
   * end can still arrive after its parent's, and is ignored like the rest.
   */
  private trackActiveToolEvent(event: AgentEvent): void {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || isNestedToolExecutionEvent(event)) return;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeToolEvents.set(toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeToolEvents.delete(toolCallId);
      const nestedPrefix = `${toolCallId}/`;
      for (const id of this.activeToolEvents.keys()) {
        if (id.startsWith(nestedPrefix)) this.activeToolEvents.delete(id);
      }
    }
  }

  private notifyAgentRunCompleteIfIdle(): void {
    if (!this.agentRunNeedsCompletion || this.isRunning()) return;
    this.agentRunNeedsCompletion = false;
    // A stopped run did not finish a task, as pi's own status reporting has it: nothing to announce.
    if (this.suppressCompletionNotifications || this.lastRunAborted) return;
    try {
      this.onAgentRunComplete?.(this.sessionId, this.inner.sessionManager.getSessionName());
    } catch (error) {
      console.error("[pi-web] completion listener failed:", error instanceof Error ? error.message : error);
    }
  }

  /** `prompt_done`, saying `aborted` when the prompt's run was stopped rather than finished. */
  private promptDoneEvent(): AgentEvent {
    return { type: "prompt_done", ...(this.lastRunAborted ? { aborted: true } : {}) };
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[pi-web] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  /**
   * A subagent run prompts the SDK session directly (`lib/subagent-runtime.ts`), past `send()`:
   * connect the session's MCP servers first, as a sent prompt does, once session_start has bound
   * the host. Stop (`abort`) ends the wait as it ends a sent prompt's, and so does `signal`.
   * Resolves whether the run may start.
   */
  async prepareMcpForRun(signal: AbortSignal): Promise<boolean> {
    const mcpHost = this.mcpHost;
    if (!mcpHost || this.inner.isStreaming) return !signal.aborted;
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop, { once: true });
    // Registered before the binding is awaited, so a Stop meanwhile already ends it.
    const waited = (async () => {
      await this.waitForExtensionsBound();
      if (!controller.signal.aborted) await mcpHost.prepareForPrompt(controller.signal);
    })().catch((error: unknown) => {
      console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
    });
    const wait = { controller, done: waited };
    this.mcpPromptWait = wait;
    try {
      await waited;
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
    }
    return !controller.signal.aborted;
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

  /** The session's extension commands as pi looks them up: by invocation name, with the extension's path. */
  private extensionCommandCandidates(): McpCommandCandidate[] {
    try {
      return this.inner.extensionRunner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        sourceInfo: command.sourceInfo,
      }));
    } catch {
      // Unreadable: treat the prompt as one that may start a run, as before.
      return [];
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

  private async withFinalIdleReset<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
    }
  }

  /** Apply a coding tool selection; `carry` defaults to the tools active now. */
  setActiveToolSelection(toolNames: string[], carry: readonly string[] = this.inner.getActiveToolNames()): void {
    this.inner.setActiveToolsByName(resolveActiveToolNames(this.inner, toolNames, carry));
  }

  /**
   * pi restores the target branch's loadout from its transcript when it navigates the tree,
   * which can bring back coding tools the pinned preset leaves out and drop codemode, so a
   * normal session applies its selection again. Chat only declares no tools, and a
   * subagent's tools are fixed by its profile; both keep what pi restored.
   */
  private async navigateTreeKeepingToolSelection(
    targetId: string,
    options: { summarize?: boolean },
  ): Promise<{ cancelled: boolean }> {
    const activeBefore = this.inner.getActiveToolNames();
    const result = await this.inner.navigateTree(targetId, options);
    if (result.cancelled || this.chatOnly) return { cancelled: result.cancelled };

    const entries = this.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    if (!readSubagentSessionResources(entries)) {
      const activeAfter = this.inner.getActiveToolNames();
      this.setActiveToolSelection(
        readSessionToolSelection(entries) ?? activeAfter,
        [...activeAfter, ...activeBefore.filter((name) => SESSION_TOOL_NAMES.has(name))],
      );
    }
    return { cancelled: false };
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
    if (!this._alive) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      return;
    }
    if (!this.isRunning()) this.forceShutdownOnIdle = false;
    // A stuck user reloads, reopens the session or presses Stop again, and
    // each of those commands lands here. Moving the forced deadline for them
    // would keep a run that Stop cannot unwind alive indefinitely.
    if (this.forceShutdownOnIdle && this.forcedIdleTimerArmed) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // A resolved timeout of 0 disables idle shutdown, but a run that Stop could
    // not unwind is still reaped after the default delay; otherwise it stays
    // running until the server restarts (#656).
    const timeoutMs = SESSION_IDLE_TIMEOUT_MS
      || (this.forceShutdownOnIdle ? DEFAULT_SESSION_IDLE_TIMEOUT_MS : 0);
    this.forcedIdleTimerArmed = timeoutMs !== 0 && this.forceShutdownOnIdle;
    if (timeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      // A visible chat keeps an SSE listener attached so server-dispatched
      // schedules can stream into that page even after a long idle period.
      if (!this.forceShutdownOnIdle && (this.isRunning() || this.listeners.size > 0 || hasActiveSessionLivenessProvider({
        sessionId: this.sessionId,
        sessionFile: this.sessionFile || undefined,
      }))) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, timeoutMs);
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

    // Pi delays the first flush until a user or assistant message exists.
    // A leading shell command is neither, so mark this SDK manager as
    // flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    for (const event of this.pendingUiRequests.values()) listener(event);
    for (const event of this.activeToolEvents.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
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
        this.notifyAgentRunCompleteIfIdle();
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
    if (!model) {
      throw this.chatOnly && findDeferredModel(this.inner.modelRuntime as ModelRuntime, provider, modelId)
        ? chatOnlyExtensionModelError(provider, modelId)
        : new Error(`Model not found: ${provider}/${modelId}`);
    }
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

  /**
   * Resolves `true` once the SDK session is disposed, or `false` after `timeoutMs`:
   * shutdown() waits for extension binding without a deadline.
   */
  waitUntilDisposed(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    return Promise.race([this.disposed.then(() => true), timedOut]).finally(() => clearTimeout(timer));
  }

  private async withSessionReplacement<T>(
    replacement: "fork" | "clone",
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.sessionReplacement) throw new Error("Session is already being copied");
    this.sessionReplacement = replacement;
    try {
      return await operation();
    } finally {
      if (this._alive) this.sessionReplacement = null;
    }
  }

  private isSessionRunningForReplacement(): boolean {
    return this.inner.isBashRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.pendingPromptCount > 0;
  }

  private async shutdownAfterSessionReplacement(replacement: "fork" | "clone"): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      console.error(
        `[pi-web] ${replacement} succeeded, but source session shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this._alive || this.deletionReserved) throw new Error("Session runtime is closed or being deleted");
    const type = command.type as string;
    const allowedDuringReplacement = COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT.has(type);
    if (this.sessionReplacement && !allowedDuringReplacement) {
      throw new Error("Session is being copied to a new session");
    }
    if (SESSION_REPLACEMENT_COMMAND_TYPES.has(type) && this.activeMutatingCommands > 0) {
      throw new Error(`Cannot ${type} while another session command is running`);
    }

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

    const tracksMutation = !allowedDuringReplacement;
    if (tracksMutation) this.activeMutatingCommands += 1;

    try {
      // Status reconciliation must not postpone forced cleanup after Stop.
      if (type !== "get_state") this.resetIdleTimer();
      if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
      if (!this._alive || this.deletionReserved) {
        throw new Error("Session runtime was closed or reserved for deletion before the command started");
      }
      if (this.sessionReplacement && !allowedDuringReplacement) {
        throw new Error("Session is being copied to a new session");
      }
      if (this.ensureSessionLease) await this.ensureSessionLease();
    } catch (error) {
      if (reservesRunAdmission) {
        this.pendingRunAdmissions--;
        notifyRunningChange();
      }
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
      throw error;
    }
    if (reservesRunAdmission) {
      this.pendingRunAdmissions--;
      notifyRunningChange();
    }

    try {
      if (type === "prompt" || type === "steer" || type === "follow_up") {
        const imageError = validateAgentImages(command.images);
        if (imageError) throw new Error(imageError);
      }
      // A session whose folder was deleted outside pi-web stays readable, but a
      // run there would reach the model only for its tools to fail (and `write`
      // to recreate the folder). The pi CLI does not resume such a session
      // either; refuse as /api/agent/new does. (A `!` command already refuses.)
      if (type === "prompt" && !existsSync(this.cwd)) {
        throw new Error(`Directory does not exist: ${this.cwd}`);
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
          const model = this.inner.model;
          if (this.chatOnlyExtensionModel && !(model && this.inner.modelRuntime.getModel(model.provider, model.id))) {
            throw chatOnlyExtensionModelError(this.chatOnlyExtensionModel.provider, this.chatOnlyExtensionModel.id);
          }
          if (this.extensionUiAbortController.signal.aborted) {
            this.extensionUiAbortController = new AbortController();
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
          let preflightDisposition: "started" | "queued" | "handled" | null = null;
          let acceptPreflight!: () => void;
          let releasePreflight!: () => void;
          let rejectPreflight!: (error: unknown) => void;
          const preflight = new Promise<void>((resolvePreflight, reject) => {
            // A started run always ends with agent_settled, so the wrapper may expect one.
            acceptPreflight = () => {
              preflightAccepted = true;
              this.agentRunNeedsCompletion = true;
              if (preflightSettled) return;
              preflightSettled = true;
              resolvePreflight();
            };
            // "queued" and "handled" inputs start no run, so no agent_settled can follow.
            // Release the RPC caller without arming completion; otherwise the session
            // stays "running" forever waiting for a settle that never arrives.
            // @author GPT-5.6 Sol
            // @version 1.0.0
            releasePreflight = () => {
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
            this.notifyAgentRunCompleteIfIdle();
          };

          this.pendingPromptCount += 1;
          // A prompt that may start a run first connects the session's MCP servers and
          // waits for the ones still connecting. The SDK runs before_agent_start before a
          // run has an abort signal, so Stop is honoured here: it ends the wait, and the
          // message is rejected unsent, which returns it to the composer. pi runs an
          // extension command before anything else and starts no run for it: another
          // extension's command skips this, and the built-in `/mcp`, which acts on the
          // registered servers, registers them without waiting (`mcpPromptPreparation()`).
          const mcpPreparation = this.mcpHost && !this.inner.isStreaming
            ? mcpPromptPreparation(typeof command.message === "string" ? command.message : "", this.extensionCommandCandidates())
            : "none";
          if (this.mcpHost && mcpPreparation !== "none") {
            const controller = new AbortController();
            const waited = this.mcpHost.prepareForPrompt(controller.signal, { wait: mcpPreparation === "wait" })
              .catch((error: unknown) => {
                console.error("[pi-web] MCP servers could not be prepared:", error instanceof Error ? error.message : error);
              })
              .then(() => {
                if (!controller.signal.aborted) return;
                finishPrompt();
                throw new Error(MCP_WAIT_STOPPED_MESSAGE);
              });
            const wait = { controller, done: waited.then(() => undefined, () => undefined) };
            this.mcpPromptWait = wait;
            try {
              await waited;
            } finally {
              if (this.mcpPromptWait === wait) this.mcpPromptWait = null;
            }
          }
          let prompt: Promise<void>;
          try {
            prompt = this.inner.prompt(command.message as string, {
              ...(promptImages?.length ? { images: promptImages } : {}),
              ...(streamingBehavior ? { streamingBehavior } : {}),
              source: "rpc",
              preflightResult: (disposition) => {
                preflightDisposition = disposition;
                // Only "started" begins a run that ends with agent_settled.
                if (disposition === "started") {
                  acceptPreflight();
                  return;
                }
                releasePreflight();
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
            // Keep the fallback arm only for prompts that really start a run. A queued or
            // extension-handled input resolves here too, but must not arm completion.
            if (preflightDisposition === "queued" || preflightDisposition === "handled") {
              releasePreflight();
            } else {
              acceptPreflight();
            }
            if (startsPrimaryRun) this.promptRunning = false;
            finishPrompt();
            if (!streamingBehavior) {
              this.emit(this.withRunIdentity(this.promptDoneEvent()));
              this.clearActiveRun(identity.runId, identity.runEpoch);
              notifyRunningChange();
            }
          }, (error) => {
            rejectPreflight(error);
            if (startsPrimaryRun && !preflightAccepted) {
              this.promptRunning = false;
              this.clearActiveRun(identity.runId, identity.runEpoch);
            }
            finishPrompt();
            invalidateSessionListCache();
            if (preflightAccepted) {
              this.emit(this.withRunIdentity({
                type: "prompt_error",
                errorMessage: error instanceof Error ? error.message : String(error),
              }));
              if (!streamingBehavior) {
                this.promptRunning = false;
                this.emit(this.withRunIdentity(this.promptDoneEvent()));
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
        this.forceShutdownOnIdle = true;
        // Arm the forced cleanup now: the reset above ran before this flag,
        // and the final reset only runs once the SDK run has unwound.
        this.resetIdleTimer();
        // Stop must unwind extension commands that have not started the agent yet.
        this.extensionUiAbortController.abort(new DOMException("Extension UI cancelled by Stop", "AbortError"));
        // A prompt still waiting for MCP servers is withdrawn before it starts a run.
        if (this.mcpPromptWait) {
          const wait = this.mcpPromptWait;
          wait.controller.abort();
          await wait.done;
        }
        try {
          await this.withFinalIdleReset(() => this.inner.abort());
          return null;
        } finally {
          if (!this.isRunning()) this.forceShutdownOnIdle = false;
        }

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
          // An exact prompt is projected onto each run by the inline extension. Every other
          // session reports `agent.state.systemPrompt`, which replays the transcript: that is
          // what the model actually saw, including sections a `before_agent_start` handler
          // changed for the run. It stays empty until the first run persists a system message,
          // so a session that has not sent anything yet falls back to the session getter, which
          // renders the prompt from the current options. The getter alone would drop those
          // per-run changes again once the run ends.
          systemPrompt: this.exactSystemPrompt?.() ?? (this.inner.agent.state?.systemPrompt || this.inner.systemPrompt || ""),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
        };
      }

      case "set_model": {
        if (this.isRunning()) throw new Error("Cannot change model while the session is busy");
        const { provider, modelId } = command as { provider: string; modelId: string };
        this.assertRuntimeSettings({ modelProvider: provider, modelId });
        return await this.setModel(provider, modelId);
      }

      case "fork": {
        if (this.isOrchestratedWorker()) {
          throw new Error("Orchestrated workers cannot be forked through the generic Session API");
        }
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        // Forking copies finished entries from disk into a new file and never
        // touches this AgentSession, so a running source keeps its run. Only an
        // idle source is shut down, because the browser moves to the child.
        const keepSource = this.isSessionRunningForReplacement();
        return this.withSessionReplacement("fork", async () => {
          const entryId = command.entryId as string;
          const sessionManager = this.inner.sessionManager;
          const currentSessionFile = this.inner.sessionFile;

          if (!sessionManager.isPersisted()) return { cancelled: true };
          if (!currentSessionFile) throw new Error("Persisted session is missing a session file");

          const entry = sessionManager.getEntry(entryId);
          if (!entry) throw new Error("Invalid entry ID for forking");

          const sessionDir = sessionManager.getSessionDir();
          let newSessionFile: string;
          let forkedManager: SessionManager;

          if (!entry.parentId) {
            // Fork before the first message: create an empty session linked to this one
            forkedManager = SessionManager.create(sessionManager.getCwd(), sessionDir, {
              parentSession: currentSessionFile,
            });
            newSessionFile = forkedManager.getSessionFile() as string;
          } else {
            // Fork after some history: copy path up to (but not including) the fork point
            if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);
            forkedManager = SessionManager.open(currentSessionFile, sessionDir);
            const forkedPath = forkedManager.createBranchedSession(entry.parentId);
            if (!forkedPath) throw new Error("Failed to create forked session");
            newSessionFile = forkedPath;
          }

          if (!existsSync(newSessionFile)) {
            const header = forkedManager.getHeader();
            if (!header) throw new Error("Forked session is missing a session header");
            const content = [header, ...forkedManager.getEntries()]
              .map((forkedEntry) => JSON.stringify(forkedEntry))
              .join("\n") + "\n";
            writeFileSync(newSessionFile, content, { encoding: "utf8", flag: "wx" });
          }

          const newSessionId = forkedManager.getSessionId();
          cacheSessionPath(newSessionId, newSessionFile);
          invalidateSessionListCache();
          if (!keepSource) await this.shutdownAfterSessionReplacement("fork");
          return { cancelled: false, newSessionId };
        });
      }

      case "fork_branch": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const entryId = command.entryId as string;
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        if (!sessionManager.isPersisted()) return { cancelled: true };
        if (!currentSessionFile) throw new Error("Persisted session is missing a session file");
        if (!sessionManager.getEntry(entryId)) throw new Error("Invalid entry ID for forking");
        if (!existsSync(currentSessionFile)) throw new Error(UNSAVED_SESSION_FORK_ERROR);

        const sessionDir = sessionManager.getSessionDir();
        const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
        const forkedPath = sourceManager.createBranchedSession(entryId);
        if (!forkedPath) throw new Error("Failed to create forked session");

        const newSessionId = SessionManager.open(forkedPath, sessionDir).getSessionId();
        cacheSessionPath(newSessionId, forkedPath);
        invalidateSessionListCache();
        return { cancelled: false, newSessionId };
      }

      case "clone": {
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Cannot clone while the session is running");
        }
        const sessionManager = this.inner.sessionManager;
        const currentSessionFile = this.inner.sessionFile;
        const leafId = typeof command.leafId === "string" ? command.leafId : sessionManager.getLeafId();
        const branchHasAssistant = leafId && sessionManager.getBranch(leafId).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        );

        if (!sessionManager.isPersisted() || !leafId || !branchHasAssistant) return { cancelled: true };
        if (!currentSessionFile || !existsSync(currentSessionFile)) return { cancelled: true };

        return await this.withSessionReplacement("clone", async () => {
          const sessionDir = sessionManager.getSessionDir();
          const sourceManager = SessionManager.open(currentSessionFile, sessionDir);
          const clonedPath = sourceManager.createBranchedSession(leafId);
          if (!clonedPath || !existsSync(clonedPath)) throw new Error("Failed to clone current session branch");

          const newSessionId = SessionManager.open(clonedPath, sessionDir).getSessionId();
          cacheSessionPath(newSessionId, clonedPath);
          invalidateSessionListCache();
          await this.shutdownAfterSessionReplacement("clone");
          return { cancelled: false, newSessionId };
        });
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        return this.navigateTreeKeepingToolSelection(command.targetId as string, {});
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
          return await this.withFinalIdleReset(() =>
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
        // A hidden tool is withdrawn: pi ignores it when setting the active tools.
        const all: ToolInfo[] = this.inner.getAllTools().filter((t) => t.exposure !== "hidden");
        const active = new Set<string>(this.inner.getActiveToolNames());
        // The definition's description is not always what the model gets: `prepareLoadout`
        // hooks rewrite the declared ones (codemode lists its nested tools and the MCP types).
        const declared = new Map((this.inner.agent.state?.tools ?? []).map((t) => [t.name, t.description]));
        // Active and callable, but requests leave the declaration out: codemode's "only" mode
        // does this to active `direct` tools. The set is private to pi 0.99's AgentSession.
        const hiddenDeclarations: unknown = Reflect.get(this.inner, "_hiddenDeclarations");
        const hidden = hiddenDeclarations instanceof Set ? hiddenDeclarations : new Set<unknown>();
        return all.map((t) => ({
          ...t,
          description: declared.get(t.name) ?? t.description,
          active: active.has(t.name),
          declarationHidden: hidden.has(t.name),
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
          this.setActiveToolSelection(toolNames);
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
        if (this.runtimePolicy) {
          this.inner.setActiveToolsByName(this.runtimePolicy.toolNames);
        } else {
          this.setActiveToolSelection(toolNames);
        }
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        // A reload invalidates the extension ctx the running turn still holds,
        // and the turn dies at its next extension hook (#1172). pi refuses too.
        if (this.isSessionRunningForReplacement()) {
          throw new Error("Wait for the current response to finish before reloading.");
        }
        if (this.extensionUiAbortController.signal.aborted) {
          this.extensionUiAbortController = new AbortController();
        }
        const activeToolNames = this.inner.getActiveToolNames();
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload();
        // pi rebuilds from the tools active before, then extensions adjust them as they start
        // again; carry that result so a tool one switched off during reload stays off.
        this.setActiveToolSelection(activeToolNames);
        if (typeof this.inner.bindExtensions !== "function") {
          this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
        }
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
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
        }
      }

      case "abort_bash": {
        this.forceShutdownOnIdle = true;
        this.resetIdleTimer();
        this.inner.abortBash();
        return null;
      }

        default:
          throw new Error(`Unsupported command: ${type}`);
      }
    } finally {
      if (tracksMutation) this.activeMutatingCommands = Math.max(0, this.activeMutatingCommands - 1);
    }
  }

  /**
   * Once, as closing starts and before extensions hear session_shutdown: the
   * MCP host's own handler runs after every other extension's, and one that
   * never returns would leave its records behind (lib/mcp-host.ts).
   */
  private disposeMcpHost(): void {
    if (this.mcpHostDisposed) return;
    this.mcpHostDisposed = true;
    try {
      this.mcpHost?.dispose();
    } catch (error) {
      console.error("[pi-web] MCP host dispose failed:", error instanceof Error ? error.message : error);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    this.disposeMcpHost();
    // Tell attached SSE listeners to drop this instance so the browser
    // EventSource errors and reconnects instead of staying OPEN on a dead wrapper.
    this.emit({ type: "session_shutdown" });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    this.activeToolEvents.clear();
    this.clearExtensionWidgets(false);
    const finishDispose = () => {
      try {
        this.inner.dispose?.();
      } finally {
        this.destroyCompletion = (async () => {
          await this.inner.waitForRuntimeCleanup?.();
          await this.onDestroyCallback?.();
        })().catch(() => {
          // Registry/lease cleanup is best-effort during process shutdown.
        });
        this.resolveDisposed();
        notifyRunningChange();
      }
    };

    // Always emit session_shutdown before dispose, even when callers skip
    // shutdown() (process exit, direct destroy). Await when possible so
    // extension MCP children can reap before the runner is invalidated.
    if (this.sessionShutdownEmitted) {
      finishDispose();
      return;
    }

    this.sessionShutdownEmitted = true;
    const emit = this.inner.extensionRunner?.emit;
    if (typeof emit !== "function") {
      finishDispose();
      return;
    }

    void this.emitSessionShutdown(emit)
      .catch((error) => {
        console.error(
          "[pi-web] session_shutdown before dispose failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(finishDispose);
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
    // Closing starts before the first await, so a request that arrives while
    // extensions shut down starts a fresh wrapper instead of prompting this one.
    this.closing = true;

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
        // After binding, so the host's session_start has run and finds nothing to record later.
        this.disposeMcpHost();
        if (!this.sessionShutdownEmitted) {
          this.sessionShutdownEmitted = true;
          const emit = this.inner.extensionRunner?.emit;
          if (typeof emit === "function") await this.emitSessionShutdown(emit);
        }
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

  /**
   * Gives extensions at most SESSION_SHUTDOWN_DEADLINE_MS to handle
   * session_shutdown, then returns so the SDK session is disposed and
   * unregistered anyway. Closing an MCP connection has no upper bound: it waits
   * for a token refresh in flight and for a stdio child whose daemonized
   * grandchild may never close stdout.
   */
  private async emitSessionShutdown(
    emit: NonNullable<AgentSessionLike["extensionRunner"]["emit"]>,
  ): Promise<void> {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("timeout"), SESSION_SHUTDOWN_DEADLINE_MS);
      // A quitting process must not wait for an extension's cleanup.
      deadlineTimer.unref?.();
    });
    // A synchronous throw becomes a rejection, and a rejection that arrives
    // after the deadline is still handled by the race below.
    const handled = (async () => {
      await emit.call(this.inner.extensionRunner, { type: "session_shutdown", reason: "quit" });
      return "handled" as const;
    })();
    try {
      if (await Promise.race([handled, deadline]) === "timeout") {
        console.warn(
          `[pi-web] extensions did not finish session_shutdown for session ${this.sessionId} within ${SESSION_SHUTDOWN_DEADLINE_MS} ms; disposing it anyway`,
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
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

    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve, reject) => {
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
        stopSignal.removeEventListener("abort", onStop);
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };
      const onStop = () => done(undefined as T);
      stopSignal.addEventListener("abort", onStop, { once: true });

      Promise.resolve()
        .then(() => (completed || stopSignal.aborted) ? undefined : factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
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
    const stopSignal = this.extensionUiAbortController.signal;
    if (stopSignal.aborted) return Promise.reject(stopSignal.reason);
    const abortSignal = signal ? AbortSignal.any([signal, stopSignal]) : stopSignal;

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        abortSignal.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
        this.emit({ type: "extension_ui_closed", id });
      };
      const settle = (value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stopSignal.aborted) reject(stopSignal.reason);
        else resolve(value);
      };
      const onAbort = () => settle(defaultValue);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      abortSignal.addEventListener("abort", onAbort, { once: true });

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
      navigateTree: (targetId, options) =>
        this.navigateTreeKeepingToolSelection(targetId, { summarize: options?.summarize }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => {
        // As pi's TUI: a command runs inside its own prompt, so the pending
        // prompt does not count; only a streaming or compacting turn does.
        const busy = this.inner.isStreaming
          ? "Wait for the current response to finish before reloading."
          : this.inner.isCompacting
            ? "Wait for compaction to finish before reloading."
            : null;
        if (busy) {
          this.emit({
            type: "extension_ui_request",
            id: randomUUID(),
            method: "notify",
            notifyType: "warning",
            message: busy,
          } as ExtensionUiRequest as AgentEvent);
          return;
        }
        this.extensionStatuses.clear();
        this.resetExtensionWidgetsForReload();
        this.syncProjectTrust();
        await this.inner.reload({
          beforeSessionStart: () => {
            this.inner.extensionRunner.setUIContext?.(this.createExtensionUiContext(), "rpc");
          },
        });
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
    const destroy = () => globalThis.__piSessions?.forEach((session) => session.destroy());
    const shutdown = () => {
      const sessions = Array.from(globalThis.__piSessions?.values() ?? []);
      void Promise.allSettled(sessions.map((session) => session.shutdown()));
    };
    // Node cannot await work from an exit handler; direct destruction starts
    // extension cleanup synchronously as a final best effort.
    process.once("exit", destroy);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piSessions;
}

function registerRpcWrapper(wrapper: AgentSessionWrapper): void {
  const registry = getRegistry();
  const sessionId = wrapper.sessionId;
  if (wrapper.sessionFile) cacheSessionPath(sessionId, wrapper.sessionFile);
  // A closing wrapper reports itself dead while extensions shut down, so the
  // next request registers a replacement under the same id. Finishing later,
  // the closing wrapper must not unregister that replacement.
  wrapper.onDestroy(() => {
    if (registry.get(sessionId) === wrapper) registry.delete(sessionId);
  });
  // A wrapper registered before a hot reload still unregisters by id alone.
  const previous = registry.get(sessionId);
  if (previous && previous !== wrapper && typeof previous.onDestroy === "function") {
    previous.onDestroy(() => {});
  }
  registry.set(sessionId, wrapper);
  wrapper.start();
  if (!wrapper.isChatOnly()) wrapper.beginExtensionBinding();
}

const SUBAGENT_CONTROLLER = createSubagentController({
  getSession: (sessionId) => getRegistry().get(sessionId),
  registerSession: (inner, options) => {
    const wrapper = new AgentSessionWrapper(inner, undefined, undefined, undefined, undefined, {
      ...(options?.exactSystemPrompt !== undefined
        ? { exactSystemPrompt: options.exactSystemPrompt }
        : {}),
      chatOnly: options?.chatOnly,
      suppressCompletionNotifications: true,
      ...(options?.mcpHost ? { mcpHost: options.mcpHost } : {}),
    });
    registerRpcWrapper(wrapper);
    return wrapper;
  },
  reopenSession: async (sessionId, sessionFile) =>
    (await startRpcSession(sessionId, sessionFile, undefined)).session,
  resolveSessionPath,
  invalidateSessionList: invalidateSessionListCache,
  isBuiltInSubagentsEnabled,
});

export function getSubagentRun(sessionId: string) {
  return SUBAGENT_CONTROLLER.get(sessionId);
}

export function steerSubagent(sessionId: string, message: string) {
  return SUBAGENT_CONTROLLER.steer(sessionId, message);
}

export function abortSubagent(sessionId: string) {
  return SUBAGENT_CONTROLLER.abort(sessionId);
}

function getLocks(): Map<string, Promise<RpcSessionStartResult>> {
  if (!globalThis.__piStartLocks) globalThis.__piStartLocks = new Map();
  return globalThis.__piStartLocks;
}

function getDeletingSessions(): Set<string> {
  if (!globalThis.__piDeletingSessions) globalThis.__piDeletingSessions = new Set();
  return globalThis.__piDeletingSessions;
}

const CLOSING_SESSION_WAIT_MARGIN_MS = 1_000;
const closingSessionWaits = new WeakMap<AgentSessionWrapper, { done: boolean; promise: Promise<void> }>();

/**
 * The wait for a wrapper of `sessionId` that is shutting down, or null when there is none
 * left to wait for. Until it is disposed the closing wrapper still owns the session: an
 * extension's session_shutdown may append to the file, which a replacement opened earlier
 * would branch away from, and dispose() releases provider resources (a Codex websocket) by
 * session id, which the replacement shares. The wait is bounded so a shutdown stuck in
 * extension binding cannot keep the session from starting again. One wait per closing
 * wrapper: its bound runs from the first caller and later callers share it, so a
 * shutdown still binding extensions can be overtaken.
 */
function closingRpcSessionWait(sessionId: string): Promise<void> | null {
  const closing = getRegistry().get(sessionId);
  // A wrapper from before a hot reload may lack waitUntilDisposed.
  if (!closing || closing.isAlive() || typeof closing.waitUntilDisposed !== "function") return null;
  let wait = closingSessionWaits.get(closing);
  if (!wait) {
    const entry = { done: false, promise: Promise.resolve() };
    entry.promise = closing.waitUntilDisposed(SESSION_SHUTDOWN_DEADLINE_MS + CLOSING_SESSION_WAIT_MARGIN_MS)
      .then((disposed) => {
        if (!disposed) console.warn(`[pi-web] session ${sessionId} is still shutting down; starting it again anyway`);
      })
      .finally(() => { entry.done = true; });
    closingSessionWaits.set(closing, entry);
    wait = entry;
  }
  return wait.done ? null : wait.promise;
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

export interface SetRpcSessionToolsResult {
  session: AgentSessionWrapper;
  sessionId: string;
  recreated: boolean;
}

/**
 * Persist a normal session's tool selection and rebuild when resource policy changes.
 * An undefined requestedToolNames returns the session to pi's configured defaults:
 * the pin is retracted and the session is rebuilt, because the loadout that
 * settings.json defaultTools resolves to is only known once pi builds the session.
 */
export async function setRpcSessionTools(
  sessionId: string,
  sessionFile: string | undefined,
  requestedToolNames: unknown,
): Promise<SetRpcSessionToolsResult> {
  const toolNames = requestedToolNames === undefined
    ? undefined
    : validateSessionToolSelection(requestedToolNames);
  const existing = getRpcSession(sessionId);

  if (!existing?.isAlive()) {
    if (!sessionFile) throw new Error("Session not found");
    // A wrapper still closing, or a start already under way, owns the file: wait for it and
    // apply the selection to whatever it left, or a start that opened the file first would
    // come up without the selection while this call reported success.
    const pending = closingRpcSessionWait(sessionId) ?? getLocks().get(sessionId);
    if (pending) {
      await pending.catch(() => undefined);
      return setRpcSessionTools(sessionId, sessionFile, requestedToolNames);
    }
    const manager = SessionManager.open(sessionFile, undefined);
    if (readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[])) {
      throw new Error("Subagent tool selection is fixed by its profile");
    }
    if (toolNames === undefined) appendClearedSessionToolSelection(manager);
    else appendSessionToolSelection(manager, toolNames);
    invalidateSessionListCache();
    const started = await startRpcSession(sessionId, sessionFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: false };
  }

  if (existing.isRunning()) throw new Error("Cannot change tools while the session is running");
  if (readSubagentSessionResources(existing.inner.sessionManager.getEntries() as unknown as SessionEntry[])) {
    throw new Error("Subagent tool selection is fixed by its profile");
  }

  const hasCurrentResourcePolicy = typeof existing.isChatOnly === "function"
    && typeof existing.setActiveToolSelection === "function";
  const crossesChatOnlyBoundary = toolNames === undefined
    || !hasCurrentResourcePolicy
    || existing.isChatOnly() !== (toolNames.length === 0);
  if (toolNames === undefined) appendClearedSessionToolSelection(existing.inner.sessionManager);
  else appendSessionToolSelection(existing.inner.sessionManager, toolNames);
  invalidateSessionListCache();

  if (toolNames !== undefined && !crossesChatOnlyBoundary) {
    existing.setActiveToolSelection(toolNames);
    return { session: existing, sessionId, recreated: false };
  }

  const persistedFile = existing.sessionFile && existsSync(existing.sessionFile)
    ? existing.sessionFile
    : undefined;
  const sessionCwd = existing.cwd;
  const model = existing.inner.model;
  const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
  await existing.shutdown();

  if (persistedFile) {
    const started = await startRpcSession(sessionId, persistedFile, undefined);
    return { session: started.session, sessionId: started.realSessionId, recreated: true };
  }

  const started = await startRpcSession(`__recreate__${randomUUID()}`, "", sessionCwd, {
    ...(toolNames !== undefined ? { toolNames } : {}),
    ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
    allowInitialModelFallback: true,
    ...(currentThinkingLevel && THINKING_LEVEL_NAMES.has(currentThinkingLevel as ThinkingLevel)
      ? { thinkingLevel: currentThinkingLevel as ThinkingLevel }
      : {}),
  });
  return { session: started.session, sessionId: started.realSessionId, recreated: true };
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
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && !options.includeTransient && (!session.isRunning() || !firstUserMessage)) continue;

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
      firstMessage: catalogFirstMessage(firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)"),
      orchestration: header?.orchestration,
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
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
// session's running state may have changed. Listeners live on globalThis so
// they survive Next.js hot-reload.
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
 * The running sessions parked on an extension's dialog, a subset of
 * getRunningRpcSessionIds(): same poll, so the sidebar can tell a run that needs
 * a person from one that is still working.
 */
export function getAwaitingInputRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isAwaitingInput()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
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
  const { initialModel, allowInitialModelFallback, thinkingLevel } = options;
  const requestedToolNames = options.toolNames === undefined
    ? undefined
    : validateSessionToolSelection(options.toolNames);
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

  const closingWait = closingRpcSessionWait(sessionId);
  if (closingWait) {
    // Concurrent starts share this lock, then the one start that follows it.
    const waiting: Promise<RpcSessionStartResult> = closingWait.then(() => {
      if (locks.get(sessionId) === waiting) locks.delete(sessionId);
      return startRpcSession(sessionId, sessionFile, cwd, options);
    });
    locks.set(sessionId, waiting);
    return waiting;
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

    const sessionEntries = sessionManager.getEntries() as unknown as SessionEntry[];
    const subagentResources = sessionFile ? readSubagentSessionResources(sessionEntries) : null;
    if (sessionFile && hasSubagentResourceSnapshot(sessionEntries) && !subagentResources) {
      throw new Error("Invalid subagent resource snapshot");
    }
    const persistedToolNames = subagentResources ? undefined : readSessionToolSelection(sessionEntries);
    const selectedToolNames = subagentResources?.tools ?? persistedToolNames ?? requestedToolNames;
    if (!subagentResources && persistedToolNames === undefined && requestedToolNames !== undefined) {
      appendSessionToolSelection(sessionManager, requestedToolNames);
    }
    const subagentLoadsResources = Boolean(
      subagentResources?.loadExtensions || subagentResources?.loadSkills || subagentResources?.codemode || subagentResources?.mcp,
    );
    const chatOnly = selectedToolNames?.length === 0 && !subagentLoadsResources;

    // Some extensions access the SDK's global theme even outside the terminal UI.
    if (!chatOnly) initTheme();
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
      const effectiveToolNames = runtimePolicy?.toolNames ?? selectedToolNames;
      const includeExtensionTools = runtimePolicy ? false : options.includeExtensionTools !== false;
      // Determine which tools to pass based on requested toolNames.
      // Since v0.68.0, session creation expects string[] tool names instead of Tool[] instances.
      let toolsOption: string[] | undefined;
      if (subagentResources) {
        toolsOption = subagentResources.tools;
      } else if (effectiveToolNames !== undefined) {
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
      const enableSessionOrchestration = !orchestrationPolicy
        && !subagentResources
        && !chatOnly
        && options.enableSessionOrchestration !== false;
      const peerTrustAllowed = runtimePolicy?.kind === "peer"
        ? runtimePolicy.projectTrusted === true && getProjectTrustStatus(sessionCwd, agentDir).trusted
        : undefined;
      const trustReloadOptions = subagentResources
        ? subagentLoadsResources
          ? projectTrustReloadOptions(sessionCwd, agentDir)
          : undefined
        : chatOnly
          ? undefined
          : peerTrustAllowed === false
            ? { resolveProjectTrust: async () => false }
            : projectTrustReloadOptions(sessionCwd, agentDir);
      const settingsManager = peerTrustAllowed === undefined
        ? SettingsManager.create(sessionCwd, agentDir)
        : SettingsManager.create(sessionCwd, agentDir, { projectTrusted: peerTrustAllowed });
      // Chat-only sessions and subagents that replace Pi's prompt send an exact
      // system prompt. The prompt is resolved at prompt time through this inline
      // extension: it may read the session's context files, which exist only
      // after the session is created, so the getter is filled in below.
      const exactSystemPromptRef: { current?: () => string } = {};
      const exactSystemPromptExtension = createExactSystemPromptExtension(() => exactSystemPromptRef.current?.());
      // codemode, tool-search, and mcp, as the pi CLI loads them, and the host that decides
      // which MCP servers the session connects (ADR 0006).
      const builtins = subagentResources || chatOnly
        ? undefined
        : await createPiWebBuiltinExtensions({ agentDir });
      const subagentCodemode = subagentResources?.codemode
        ? await createSubagentCodemodeExtension({
            agentDir,
            cwd: sessionCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
          })
        : undefined;
      const subagentMcp = subagentResources?.mcp
        ? await createSubagentMcpExtensions({
            agentDir,
            cwd: sessionCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
            codemode: subagentResources.codemode === true,
          })
        : undefined;
      const skillsBinding = subagentResources ? createSubagentSkillsBinding({
        loadSkills: subagentResources.loadSkills,
        skills: subagentResources.skills,
        exactSystemPrompt: subagentResources.exactSystemPrompt
          ?? (chatOnly ? subagentResources.appendSystemPrompt[0] ?? "" : undefined),
      }) : undefined;
      const subagentExtensionFactories = [
        ...(subagentCodemode ? [subagentCodemode] : []),
        ...(subagentMcp && subagentResources
          ? [...subagentMcp.extensions, createSubagentMcpPolicyExtension(() => subagentResources)]
          : []),
        ...(skillsBinding?.loaderOptions.extensionFactories ?? []),
      ];
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
        ...(builtins?.extensions ?? []),
        createReadOnlyMcpPolicyExtension(),
        createProjectCommandBashExtension({ cwd: sessionCwd, settings: settingsManager }),
        createSubagentExtension(
          SUBAGENT_CONTROLLER.extensionRuntime,
          () => listSubagentProfiles(sessionCwd),
          isBuiltInSubagentsEnabled,
        ),
      ];
      const resourceLoaderOptions = orchestrationPolicy
        ? { extensionsOverride: isolateOrchestratedSessionExtensions }
        : subagentResources
          ? {
              ...subagentExtensionLoaderOptions(subagentResources),
              ...skillsBinding!.loaderOptions,
              ...(subagentExtensionFactories.length > 0 ? { extensionFactories: subagentExtensionFactories } : {}),
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              ...(chatOnly
                ? {
                    systemPrompt: " ",
                    systemPromptOverride: () => undefined,
                  }
                : {}),
              appendSystemPrompt: subagentResources.appendSystemPrompt,
            }
          : chatOnly
            ? { ...CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories: [exactSystemPromptExtension] }
            : {
                extensionFactories,
                extensionsOverride: (base: LoadExtensionsResult) => preferUserBashExtension(preferPiWebSubagentExtension(base)),
              };
      const services = await createAgentSessionServices({
        cwd: sessionCwd,
        agentDir,
        settingsManager,
        resourceLoaderOptions,
        ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
      });
      if (subagentResources?.codemode
        && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }
      const scope = await resolveVisibleModels(
        services.modelRuntime,
        services.settingsManager.getEnabledModels(),
      );
      // A provider an extension registers only at session_start (lib/deferred-provider-models.ts)
      // has no model in this runtime yet: build on the default, switch once extensions are bound.
      const deferredInitialModel = initialModel && !services.modelRuntime.getModel(initialModel.provider, initialModel.modelId)
        ? findDeferredModel(services.modelRuntime, initialModel.provider, initialModel.modelId)
        : undefined;
      // Chat only loads no extensions, so that switch never comes: refuse the model the browser chose.
      if (chatOnly && deferredInitialModel && !allowInitialModelFallback) {
        throw chatOnlyExtensionModelError(deferredInitialModel.provider, deferredInitialModel.id);
      }
      const effectiveInitialModel = initialModel && !deferredInitialModel && (
        !allowInitialModelFallback
        || scope.visible.some((model) => model.provider === initialModel.provider && model.id === initialModel.modelId)
      )
        ? initialModel
        : undefined;
      const defaultProvider = services.settingsManager.getDefaultProvider();
      const defaultModelId = services.settingsManager.getDefaultModel();
      const branch = sessionManager.getBranch();
      // System messages carry the prompt and tool loadout, not a conversation.
      const hasExistingMessages = branch.some((entry) => entry.type === "message" && entry.message.role !== "system");
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
      const requestedModel = runtimePolicy?.model ?? effectiveInitialModel ?? persistedModel;
      const requestedThinking = thinkingLevel ?? persistedThinking;
      const savedModel = hasExistingMessages
        ? getLatestModelChange(branch as unknown as SessionEntry[])
        : null;
      const restoredModel = savedModel
        ? services.modelRuntime.getModel(savedModel.provider, savedModel.modelId)
        : undefined;
      const initial = hasExistingMessages ? null : selectInitialModelScope(scope, {
        ...(requestedModel ? { requestedModel } : {}),
        ...(defaultProvider && defaultModelId
          ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
          : {}),
        ...(requestedThinking ? { thinkingLevel: requestedThinking } : {}),
      });
      const startupModel = restoredModel && services.modelRuntime.hasConfiguredAuth(restoredModel.provider)
        ? restoredModel
        : initial?.model;
      const initialScopedModels = initial?.scopedModels ?? [];
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(startupModel ? { model: startupModel } : {}),
        ...(initial?.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(hasExistingMessages
          ? { scopedModels: [...scope.scopedModels] }
          : initialScopedModels.length > 0
            ? { scopedModels: initialScopedModels }
            : {}),
        ...(subagentResources
          ? subagentToolOptions(subagentResources)
          : toolsOption !== undefined ? { tools: toolsOption } : {}),
        ...(orchestrationPolicy ? { orchestratedWorkerRuntime: orchestrationLease } : {}),
        ...(peerStartupPolicy ? { peerSessionRuntime: options.peerSessionRuntime } : {}),
        ...(!orchestrationPolicy && sessionLease ? { sessionFileRuntime: sessionLease } : {}),
      });

      // A pinned selection replaces only the coding tools of the SDK's initial loadout, which
      // already holds the extension tools pi activates on registration and whatever
      // `defaultTools` names (such as `+codemode`), so installed extensions stay usable in
      // Pi Web just like in the `pi` CLI.
      if (!subagentResources && !chatOnly) {
        const initialToolNames = inner.getActiveToolNames();
        inner.setActiveToolsByName(
          resolveActiveToolNames(inner, selectedToolNames ?? initialToolNames, initialToolNames),
        );
      }

      skillsBinding?.setActiveToolsGetter(() => inner.getActiveToolNames());
      const exactSystemPrompt = subagentResources
        ? skillsBinding!.getExactSystemPrompt
        : chatOnly
          ? () => contextFilesSystemPrompt(inner.resourceLoader.getAgentsFiles().agentsFiles)
          : undefined;
      exactSystemPromptRef.current = exactSystemPrompt;
      const deferredModel = hasExistingMessages
        ? savedModel && !restoredModel
          ? findDeferredModel(services.modelRuntime, savedModel.provider, savedModel.modelId)
          : undefined
        : deferredInitialModel;
      // The extension's model a Chat-only session wanted (saved, chosen or default); a prompt names
      // it when the session ended up with no model at all.
      const chatOnlyExtensionModel = chatOnly
        ? deferredModel ?? (!hasExistingMessages && defaultProvider && defaultModelId
          ? findDeferredModel(services.modelRuntime, defaultProvider, defaultModelId)
          : undefined)
        : undefined;
      const mcpHost = builtins?.mcpHost ?? subagentMcp?.mcpHost;
      const wrapper = new AgentSessionWrapper(
        inner,
        runtimePolicy,
        undefined,
        ensureGenericSessionLease,
        () => runtimeTarget,
        {
          ...(exactSystemPrompt ? { exactSystemPrompt } : {}),
          chatOnly,
          onAgentRunComplete: (completedSessionId, sessionName) => {
            void notifySessionComplete(completedSessionId, sessionName).catch((error) => {
              console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error);
            });
          },
          suppressCompletionNotifications: Boolean(subagentResources),
          ...(mcpHost ? { mcpHost } : {}),
          ...(chatOnlyExtensionModel ? { chatOnlyExtensionModel } : {}),
        },
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

      if (!chatOnly) {
        if (deferredModel) {
          try {
            await wrapper.waitUntilReady();
            await wrapper.send({ type: "set_model", provider: deferredModel.provider, modelId: deferredModel.id });
          } catch (error) {
            console.error(`[pi-web] could not switch to ${deferredModel.provider}/${deferredModel.id}:`, error instanceof Error ? error.message : error);
          }
        }
        // Bound extensions may have registered providers a later model listing will not see.
        void wrapper.waitUntilReady()
          .then(() => rememberProviderModels(inner.modelRuntime as ModelRuntime))
          .catch(() => undefined);
      }

      const realSessionId = inner.sessionId as string;
      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      wrapper.onDestroy(async () => {
        if (registry.get(realSessionId) === wrapper) registry.delete(realSessionId);
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
