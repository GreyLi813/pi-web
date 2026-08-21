import { randomUUID } from "node:crypto";
import {
  acquireScheduleLeaderLease,
  authorizePeerSessionRuntime,
  DEFAULT_SCHEDULE_CLAIM_MS,
  getAgentDir,
  ScheduleStore,
  type ScheduleEntry,
  type PeerSessionRuntimeAuthority,
  type ScheduleLeaderLease,
  type VerifiedSessionTarget,
  verifyStoredSessionTarget,
} from "@earendil-works/pi-coding-agent";
import {
  dispatchScheduleToAgent,
  type ScheduleAgent,
  type ScheduleRunObserved,
  ScheduleRunTerminalUnconfirmedError,
  type ScheduleRunTerminalOutcome,
} from "./schedule-dispatch";
import {
  PendingScheduleRunRegistry,
  type PendingScheduleRunReservation,
} from "./pending-schedule-runs";
import { getRpcSession, startAuthorizedPeerRpcSession, startRpcSession } from "./rpc-manager";

const SCHEDULER_INTERVAL_MS = 5_000;
const SCHEDULER_RETRY_MS = 5_000;
const SCHEDULER_CONCURRENCY = 2;
const SCHEDULER_START_TIMEOUT_MS = 60_000;
const BUSY_RETRY_MS = 2_000;
const standalonePendingRuns = new PendingScheduleRunRegistry();

export interface ValidatedScheduleTarget {
  target: VerifiedSessionTarget;
  peerRuntimeAuthority?: PeerSessionRuntimeAuthority;
}

export interface SessionSchedulerDependencies {
  getSession(sessionId: string): ScheduleAgent | undefined;
  startSession(schedule: ScheduleEntry, validated: ValidatedScheduleTarget): Promise<ScheduleAgent>;
  dispatchSchedule?(
    schedule: ScheduleEntry,
    agent: ScheduleAgent,
    onRunObserved?: ScheduleRunObserved,
  ): ReturnType<typeof dispatchScheduleToAgent>;
  now(): number;
}

export interface SchedulePassResult {
  claimed: number;
  succeeded: number;
  failed: number;
  deferred: number;
}

export interface ScheduleClaimLeaseOptions {
  claimLeaseMs?: number;
  heartbeatIntervalMs?: number;
  pendingRunRegistry?: PendingScheduleRunRegistry;
}

interface ResolvedScheduleClaimLeaseOptions {
  claimLeaseMs: number;
  heartbeatIntervalMs: number;
}

/** Return a bounded error suitable for persistent schedule state.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** Return whether an execution error must stop instead of retrying.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function isAuthorizationFailure(error: unknown): boolean {
  return /identity|authorization|authority|endpoint|policy cannot be changed|not a durable peer|orchestrated worker|does not match/i.test(errorMessage(error));
}

/** Bound one startup operation so a broken extension cannot freeze every future pass.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keep one exact claim alive while this process still owns startup/execution.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function startScheduleClaimHeartbeat(
  store: ScheduleStore,
  schedule: ScheduleEntry,
  ownerId: string,
  dependencies: SessionSchedulerDependencies,
  options: ResolvedScheduleClaimLeaseOptions,
): { stop(): Promise<void> } {
  const claim = schedule.claim;
  if (!claim) throw new Error("Scheduler cannot heartbeat an unclaimed schedule");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  let reportedFailure = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      renewal = Promise.resolve().then(() => store.renewClaim(schedule.id, claim.runId, ownerId, {
        now: dependencies.now(),
        leaseMs: options.claimLeaseMs,
      })).then(() => {
        reportedFailure = false;
      }).catch((error) => {
        if (!reportedFailure && !stopped) {
          reportedFailure = true;
          console.error(`[scheduler] claim heartbeat failed for ${schedule.id}:`, errorMessage(error));
        }
      }).finally(() => {
        renewal = undefined;
        scheduleNext();
      });
    }, options.heartbeatIntervalMs);
    timer.unref?.();
  };

  scheduleNext();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await renewal?.catch(() => undefined);
    },
  };
}

/** Revalidate the exact physical target and durable peer scheduling permission.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function validateClaimTarget(agentDir: string, schedule: ScheduleEntry): Promise<ValidatedScheduleTarget> {
  const target = await verifyStoredSessionTarget(schedule.target);
  if (target.header.orchestration !== undefined) {
    throw new Error("Orchestrated worker Sessions cannot receive schedules");
  }
  if (target.header.peer !== undefined) {
    const peerRuntimeAuthority = await authorizePeerSessionRuntime(agentDir, target);
    if (
      target.header.peer.authorization.schedule !== true
      || schedule.peerAuthorityId !== peerRuntimeAuthority.authorityId
    ) {
      throw new Error("Peer Session scheduling authorization is invalid");
    }
    return { target, peerRuntimeAuthority };
  }
  if (schedule.peerAuthorityId) throw new Error("Ordinary schedule has an invalid peer authority binding");
  return { target };
}

/** Dispatch one exact claim and persist a terminal or deferred outcome.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function dispatchClaim(
  store: ScheduleStore,
  schedule: ScheduleEntry,
  ownerId: string,
  dependencies: SessionSchedulerDependencies,
  leaseOptions: ResolvedScheduleClaimLeaseOptions,
  pendingRuns: PendingScheduleRunRegistry,
): Promise<"succeeded" | "failed" | "deferred"> {
  const claim = schedule.claim;
  if (!claim) throw new Error("Scheduler received an unclaimed schedule");
  const reserved = pendingRuns.reserve({
    storePath: store.filePath,
    scheduleId: schedule.id,
    runId: claim.runId,
    ownerId,
  });
  if (reserved.status === "duplicate") return "deferred";
  if (reserved.status === "full") {
    await store.releaseClaim(
      schedule.id,
      claim.runId,
      ownerId,
      dependencies.now() + SCHEDULER_RETRY_MS,
      "Pending Schedule monitor capacity is full",
    );
    return "deferred";
  }

  const reservation: PendingScheduleRunReservation = reserved.reservation;
  const heartbeat = startScheduleClaimHeartbeat(store, schedule, ownerId, dependencies, leaseOptions);
  pendingRuns.setHeartbeat(reservation, heartbeat);
  let terminalTransferred = false;
  const observeRun: ScheduleRunObserved = (observer) => {
    pendingRuns.attachObserver(reservation, observer);
  };

  try {
    let validated: ValidatedScheduleTarget;
    try {
      validated = await validateClaimTarget(store.agentDir, schedule);
    } catch (error) {
      await store.pause(schedule.id, `Invalid schedule target: ${errorMessage(error)}`);
      return "failed";
    }

    let markedRunning = false;
    try {
      let agent = dependencies.getSession(schedule.target.sessionId);
      if (agent !== undefined && typeof agent.isRunning !== "function") {
        throw new Error("Schedule target wrapper is invalid");
      }
      if (
        agent
        && (agent.sessionFile !== schedule.target.sessionFile || agent.sessionFileKey !== schedule.target.fileKey)
      ) {
        throw new Error("Schedule target wrapper physical identity does not match");
      }
      if (!agent) {
        agent = await withTimeout(
          dependencies.startSession(schedule, validated),
          SCHEDULER_START_TIMEOUT_MS,
          "Schedule target startup",
        );
      }
      if (agent.isRunning()) {
        await store.releaseClaim(
          schedule.id,
          claim.runId,
          ownerId,
          dependencies.now() + BUSY_RETRY_MS,
          "Target Session is busy",
        );
        return "deferred";
      }
      await store.markRunning(schedule.id, claim.runId, ownerId, dependencies.now());
      markedRunning = true;
      const result = dependencies.dispatchSchedule
        ? await dependencies.dispatchSchedule(schedule, agent, observeRun)
        : await dispatchScheduleToAgent(schedule, agent, undefined, undefined, observeRun);
      if (!result) {
        throw new Error("Target Session became busy before scheduled prompt admission");
      }
      await store.completeRun(schedule.id, claim.runId, ownerId, {
        status: "succeeded",
        finishedAt: dependencies.now(),
        usage: result.usage,
      });
      return "succeeded";
    } catch (error) {
      if (error instanceof ScheduleRunTerminalUnconfirmedError) {
        pendingRuns.attachObserver(reservation, error.observer);
        terminalTransferred = true;
        await store.markPendingTerminal(schedule.id, claim.runId, ownerId, dependencies.now()).catch((markError) => {
          console.error(`[scheduler] could not persist pending-terminal state for ${schedule.id}:`, errorMessage(markError));
        });
        pendingRuns.monitorTerminal(reservation, async (outcome: ScheduleRunTerminalOutcome) => {
          if (outcome.status === "succeeded") {
            await store.completeRun(schedule.id, claim.runId, ownerId, {
              status: "succeeded",
              finishedAt: dependencies.now(),
              usage: outcome.result.usage,
            });
          } else {
            await store.completeRun(schedule.id, claim.runId, ownerId, {
              status: "failed",
              finishedAt: dependencies.now(),
              error: errorMessage(outcome.error),
            });
          }
        });
        return "deferred";
      }
      if (isAuthorizationFailure(error)) {
        if (markedRunning) {
          await store.completeRun(schedule.id, claim.runId, ownerId, {
            status: "failed",
            finishedAt: dependencies.now(),
            error: errorMessage(error),
          }).catch(() => undefined);
        }
        await store.pause(schedule.id, `Schedule authorization stopped: ${errorMessage(error)}`);
        return "failed";
      }
      if (!markedRunning) {
        await store.releaseClaim(
          schedule.id,
          claim.runId,
          ownerId,
          dependencies.now() + SCHEDULER_RETRY_MS,
          errorMessage(error),
        ).catch(() => undefined);
        return "deferred";
      }
      await store.completeRun(schedule.id, claim.runId, ownerId, {
        status: "failed",
        finishedAt: dependencies.now(),
        error: errorMessage(error),
      });
      return "failed";
    }
  } finally {
    if (!terminalTransferred) await pendingRuns.release(reservation);
  }
}

/** Claim and dispatch one isolated batch; one failure never blocks its siblings.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function runSchedulePass(
  store: ScheduleStore,
  ownerId: string,
  dependencies: SessionSchedulerDependencies,
  concurrency: number = SCHEDULER_CONCURRENCY,
  leaseOptions: ScheduleClaimLeaseOptions = {},
): Promise<SchedulePassResult> {
  const claimLeaseMs = leaseOptions.claimLeaseMs ?? DEFAULT_SCHEDULE_CLAIM_MS;
  if (!Number.isSafeInteger(claimLeaseMs) || claimLeaseMs < 1_000) {
    throw new Error("Schedule claim lease must be a safe integer of at least 1000ms");
  }
  const heartbeatIntervalMs = leaseOptions.heartbeatIntervalMs
    ?? Math.max(10, Math.min(30_000, Math.floor(claimLeaseMs / 4)));
  if (
    !Number.isSafeInteger(heartbeatIntervalMs)
    || heartbeatIntervalMs < 10
    || heartbeatIntervalMs >= claimLeaseMs
  ) {
    throw new Error("Schedule claim heartbeat must be a safe integer between 10ms and the claim lease");
  }
  const resolvedLeaseOptions = { claimLeaseMs, heartbeatIntervalMs };
  const pendingRuns = leaseOptions.pendingRunRegistry ?? standalonePendingRuns;
  const claims = await store.claimDue({
    ownerId,
    now: dependencies.now(),
    limit: Math.max(1, Math.min(8, Math.trunc(concurrency))),
    leaseMs: claimLeaseMs,
  });
  const outcomes = await Promise.allSettled(
    claims.map((schedule) => dispatchClaim(
      store,
      schedule,
      ownerId,
      dependencies,
      resolvedLeaseOptions,
      pendingRuns,
    )),
  );
  const result: SchedulePassResult = { claimed: claims.length, succeeded: 0, failed: 0, deferred: 0 };
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") result.failed++;
    else result[outcome.value]++;
  }
  return result;
}

/** Start and own the Node-process scheduler loop plus its cross-process leader lease.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export class PersistentSessionScheduler {
  private readonly store: ScheduleStore;
  private readonly ownerId: string;
  private readonly dependencies: SessionSchedulerDependencies;
  private readonly pendingRuns: PendingScheduleRunRegistry;
  private leaderLease: ScheduleLeaderLease | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private leadershipRetry: ReturnType<typeof setTimeout> | undefined;
  private pass: Promise<SchedulePassResult> | undefined;
  private stopped = false;

  /** Bind the scheduler to one explicit Agent directory and runtime registry.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  constructor(
    agentDir: string,
    dependencies: SessionSchedulerDependencies,
    ownerId: string = `pi-web-${process.pid}-${randomUUID()}`,
    pendingRuns: PendingScheduleRunRegistry = new PendingScheduleRunRegistry(),
  ) {
    this.store = new ScheduleStore(agentDir);
    this.dependencies = dependencies;
    this.ownerId = ownerId;
    this.pendingRuns = pendingRuns;
  }

  /** Acquire leadership and recover due/expired work without a browser wake-up.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async start(): Promise<void> {
    if (this.stopped || this.leaderLease) return;
    try {
      this.leaderLease = await acquireScheduleLeaderLease(this.store.agentDir, this.ownerId);
      this.interval = setInterval(() => { void this.runNow(); }, SCHEDULER_INTERVAL_MS);
      void this.runNow();
    } catch (error) {
      if (!/Another ScheduleStore leader/.test(errorMessage(error))) {
        console.error("[scheduler] leader startup failed:", errorMessage(error));
      }
      if (!this.stopped && !this.leadershipRetry) {
        this.leadershipRetry = setTimeout(() => {
          this.leadershipRetry = undefined;
          void this.start();
        }, SCHEDULER_RETRY_MS);
      }
    }
  }

  /** Run at most one coalesced dispatcher pass when this process is leader.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async runNow(): Promise<SchedulePassResult> {
    if (!this.leaderLease) return { claimed: 0, succeeded: 0, failed: 0, deferred: 0 };
    if (this.pass) return this.pass;
    this.pass = runSchedulePass(this.store, this.ownerId, this.dependencies, SCHEDULER_CONCURRENCY, {
      pendingRunRegistry: this.pendingRuns,
    })
      .catch((error) => {
        console.error("[scheduler] pass failed:", errorMessage(error));
        return { claimed: 0, succeeded: 0, failed: 1, deferred: 0 };
      })
      .finally(() => { this.pass = undefined; });
    return this.pass;
  }

  /** Request cancellation of one exact run still observed by this scheduler process.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  requestRunCancel(scheduleId: string, runId: string): Promise<boolean> {
    return this.pendingRuns.requestCancel({
      storePath: this.store.filePath,
      scheduleId,
      runId,
    });
  }

  /** Return process-owned run monitors for diagnostics and tests.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  pendingRunCount(): number {
    return this.pendingRuns.size;
  }

  /** Stop timers and relinquish leadership, optionally without waiting for a bounded run.
   *
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async stop(options: { waitForPass?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.leadershipRetry) clearTimeout(this.leadershipRetry);
    this.interval = undefined;
    this.leadershipRetry = undefined;
    if (options.waitForPass !== false) await this.pass?.catch(() => undefined);
    await this.pendingRuns.shutdown();
    await this.leaderLease?.release().catch(() => undefined);
    this.leaderLease = undefined;
  }
}

declare global {
  var __piPersistentSessionScheduler: PersistentSessionScheduler | undefined;
}

/** Build production dependencies over the exact-file Pi-Web RPC registry.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function productionDependencies(): SessionSchedulerDependencies {
  return {
    getSession: (sessionId) => getRpcSession(sessionId),
    startSession: async (schedule, validated) => {
      const startupOptions = {
        toolNames: [...schedule.policy.toolNames],
        initialModel: schedule.policy.model,
        thinkingLevel: schedule.policy.thinkingLevel,
        includeExtensionTools: false,
        preserveSystemPromptWithoutTools: true,
      };
      const { session } = validated.peerRuntimeAuthority
        ? await startAuthorizedPeerRpcSession(
            schedule.target,
            validated.peerRuntimeAuthority,
            startupOptions,
          )
        : await startRpcSession(
            schedule.target.sessionId,
            schedule.target.sessionFile,
            schedule.target.cwd,
            { ...startupOptions, expectedSessionTarget: schedule.target },
          );
      if (!session.matchesSessionTarget(schedule.target)) {
        throw new Error("Started Session physical identity does not match the schedule target");
      }
      return session;
    },
    now: () => Date.now(),
  };
}

/** Start the singleton scheduler from the Pi-Web Node service lifecycle.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function startPersistentSessionScheduler(): Promise<PersistentSessionScheduler> {
  if (!globalThis.__piPersistentSessionScheduler) {
    const scheduler = new PersistentSessionScheduler(getAgentDir(), productionDependencies());
    globalThis.__piPersistentSessionScheduler = scheduler;
    const terminate = (signal: NodeJS.Signals) => {
      void scheduler.stop({ waitForPass: false }).finally(() => process.kill(process.pid, signal));
    };
    process.once("SIGINT", () => terminate("SIGINT"));
    process.once("SIGTERM", () => terminate("SIGTERM"));
  }
  await globalThis.__piPersistentSessionScheduler.start();
  return globalThis.__piPersistentSessionScheduler;
}

/** Cancel only a run still owned by the active process monitor.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function requestPersistentScheduleRunCancel(scheduleId: string, runId: string): Promise<boolean> {
  const scheduler = globalThis.__piPersistentSessionScheduler;
  if (!scheduler) return false;
  return scheduler.requestRunCancel(scheduleId, runId);
}

/** Treat a browser ticker as an optional extra wake-up, never the scheduler owner.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function wakePersistentSessionScheduler(): Promise<SchedulePassResult> {
  const scheduler = await startPersistentSessionScheduler();
  return scheduler.runNow();
}
