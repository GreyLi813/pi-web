import type {
  ScheduleRunObserver,
  ScheduleRunTerminalOutcome,
} from "./schedule-dispatch";

export const MAX_PENDING_SCHEDULE_RUNS = 50;
const TERMINAL_PERSIST_RETRY_MS = 1_000;

export interface ScheduleClaimHeartbeat {
  stop(): Promise<void>;
}

export interface PendingScheduleRunReservation {
  readonly key: string;
  readonly token: symbol;
}

export interface PendingScheduleRunIdentity {
  storePath: string;
  scheduleId: string;
  runId: string;
  ownerId: string;
}

export type PendingScheduleRunReserveResult =
  | { status: "reserved"; reservation: PendingScheduleRunReservation }
  | { status: "duplicate" }
  | { status: "full" };

interface PendingScheduleRunEntry extends PendingScheduleRunIdentity {
  key: string;
  token: symbol;
  active: boolean;
  status: "starting" | "running" | "pending-terminal";
  heartbeat?: ScheduleClaimHeartbeat;
  observer?: ScheduleRunObserver;
  monitoring: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  wakeRetry?: () => void;
  completionFailureReported: boolean;
}

/** Build a process-local key for one exact persisted claim.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function pendingScheduleRunKey(identity: Pick<PendingScheduleRunIdentity, "storePath" | "scheduleId" | "runId">): string {
  return `${identity.storePath}\u0000${identity.scheduleId}\u0000${identity.runId}`;
}

/** Bound and own live scheduled-run observers for one Pi-Web process.
 *
 * Reservations happen before a model turn starts, so capacity exhaustion can
 * defer an untouched claim instead of abandoning an already-running observer.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export class PendingScheduleRunRegistry {
  private readonly entries = new Map<string, PendingScheduleRunEntry>();
  private stopped = false;

  constructor(private readonly maxEntries: number = MAX_PENDING_SCHEDULE_RUNS) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Pending Schedule monitor capacity must be a positive safe integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Reserve bounded ownership before startup can produce side effects.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  reserve(identity: PendingScheduleRunIdentity): PendingScheduleRunReserveResult {
    if (this.stopped) return { status: "full" };
    const key = pendingScheduleRunKey(identity);
    if (this.entries.has(key)) return { status: "duplicate" };
    if (this.entries.size >= this.maxEntries) return { status: "full" };
    const token = Symbol(key);
    this.entries.set(key, {
      ...identity,
      key,
      token,
      active: true,
      status: "starting",
      monitoring: false,
      completionFailureReported: false,
    });
    return { status: "reserved", reservation: { key, token } };
  }

  /** Bind the exact heartbeat created for this reservation.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  setHeartbeat(reservation: PendingScheduleRunReservation, heartbeat: ScheduleClaimHeartbeat): void {
    const entry = this.requireEntry(reservation);
    if (entry.heartbeat) throw new Error("Schedule run heartbeat is already registered");
    entry.heartbeat = heartbeat;
  }

  /** Attach one exact terminal observer; duplicate observers fail closed.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  attachObserver(reservation: PendingScheduleRunReservation, observer: ScheduleRunObserver): void {
    const entry = this.requireEntry(reservation);
    if (observer.runId !== entry.runId) throw new Error("Schedule terminal observer run identity does not match");
    if (entry.observer) {
      if (entry.observer === observer) return;
      throw new Error("Schedule run already has a different terminal observer");
    }
    entry.observer = observer;
    entry.status = "running";
  }

  /** Transfer terminal persistence to the background without dropping ownership.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  monitorTerminal(
    reservation: PendingScheduleRunReservation,
    complete: (outcome: ScheduleRunTerminalOutcome) => Promise<void>,
  ): boolean {
    const entry = this.requireEntry(reservation);
    if (!entry.observer) throw new Error("Pending Schedule run has no terminal observer");
    if (entry.monitoring) return false;
    entry.monitoring = true;
    entry.status = "pending-terminal";
    void entry.observer.terminal.then(
      (outcome) => this.persistTerminal(entry, outcome, complete),
      (error) => this.persistTerminal(entry, { status: "failed", error }, complete),
    ).catch((error) => {
      if (entry.active) {
        console.error(`[scheduler] pending terminal monitor failed for ${entry.scheduleId}:`, this.errorMessage(error));
      }
    });
    return true;
  }

  /** Send a cancellation only to the exact process-owned run.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async requestCancel(identity: Pick<PendingScheduleRunIdentity, "storePath" | "scheduleId" | "runId">): Promise<boolean> {
    const entry = this.entries.get(pendingScheduleRunKey(identity));
    if (!entry?.active || !entry.observer) return false;
    await entry.observer.requestCancel();
    return true;
  }

  /** Release a normally completed/deferred reservation and stop its heartbeat.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async release(reservation: PendingScheduleRunReservation): Promise<void> {
    const entry = this.entries.get(reservation.key);
    if (!entry || entry.token !== reservation.token) return;
    await this.removeEntry(entry);
  }

  /** Stop every timer and detach every monitor during service shutdown.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  async shutdown(): Promise<void> {
    if (this.stopped && this.entries.size === 0) return;
    this.stopped = true;
    const entries = [...this.entries.values()];
    await Promise.all(entries.map((entry) => this.removeEntry(entry)));
  }

  /** Test/host diagnostics without exposing mutable observer objects.
   * @author GPT-5.6 Sol
   * @version 1.0.0
   */
  list(): Array<PendingScheduleRunIdentity & { status: "starting" | "running" | "pending-terminal" }> {
    return [...this.entries.values()].map(({ storePath, scheduleId, runId, ownerId, status }) => ({
      storePath,
      scheduleId,
      runId,
      ownerId,
      status,
    }));
  }

  private requireEntry(reservation: PendingScheduleRunReservation): PendingScheduleRunEntry {
    const entry = this.entries.get(reservation.key);
    if (!entry || entry.token !== reservation.token || !entry.active) {
      throw new Error("Schedule run monitor reservation is no longer active");
    }
    return entry;
  }

  private async persistTerminal(
    entry: PendingScheduleRunEntry,
    outcome: ScheduleRunTerminalOutcome,
    complete: (outcome: ScheduleRunTerminalOutcome) => Promise<void>,
  ): Promise<void> {
    while (entry.active) {
      try {
        await complete(outcome);
        if (entry.active) await this.removeEntry(entry);
        return;
      } catch (error) {
        if (/no longer belongs|not found/i.test(this.errorMessage(error))) {
          await this.removeEntry(entry);
          return;
        }
        if (!entry.completionFailureReported) {
          entry.completionFailureReported = true;
          console.error(`[scheduler] terminal persistence failed for ${entry.scheduleId}; retrying:`, this.errorMessage(error));
        }
        await this.waitForRetry(entry);
      }
    }
  }

  private waitForRetry(entry: PendingScheduleRunEntry): Promise<void> {
    if (!entry.active) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = (): void => {
        if (entry.retryTimer) clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
        entry.wakeRetry = undefined;
        resolve();
      };
      entry.wakeRetry = finish;
      entry.retryTimer = setTimeout(finish, TERMINAL_PERSIST_RETRY_MS);
      entry.retryTimer.unref?.();
    });
  }

  private async removeEntry(entry: PendingScheduleRunEntry): Promise<void> {
    if (!entry.active) return;
    entry.active = false;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.wakeRetry?.();
    entry.wakeRetry = undefined;
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
    await entry.heartbeat?.stop().catch(() => undefined);
    entry.heartbeat = undefined;
    entry.observer = undefined;
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  }
}
