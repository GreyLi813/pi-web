import type {
  ScheduleEntry,
  ScheduleRunUsage,
} from "@earendil-works/pi-coding-agent";

export type PersistentSchedule = ScheduleEntry;

export const SCHEDULE_RUN_TIMEOUT_MS = 4 * 60_000;

export interface ScheduleAgent {
  readonly sessionFile?: string;
  readonly sessionFileKey?: string;
  isRunning(): boolean;
  isOrchestratedWorker?(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
}

export type ScheduleRunTerminalOutcome =
  | { status: "succeeded"; result: ScheduleDispatchResult }
  | { status: "failed"; error: unknown };

export interface ScheduleRunObserver {
  runId: string;
  runEpoch: number;
  terminal: Promise<ScheduleRunTerminalOutcome>;
  requestCancel(): Promise<void>;
}

export type ScheduleRunObserved = (observer: ScheduleRunObserver) => void;

export class ScheduleRunTerminalUnconfirmedError extends Error {
  readonly observer: ScheduleRunObserver;

  constructor(observer: ScheduleRunObserver) {
    super(`Scheduled run ${observer.runId}/${observer.runEpoch} did not reach a confirmed terminal state`);
    this.name = "ScheduleRunTerminalUnconfirmedError";
    this.observer = observer;
  }
}

export interface ScheduleDispatchResult {
  runId: string;
  runEpoch: number;
  usage?: ScheduleRunUsage;
}

/** Read a non-negative server epoch from one wrapper state response.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function stateRunEpoch(result: unknown): number {
  if (!result || typeof result !== "object") throw new Error("Schedule target returned invalid state");
  const epoch = (result as { runEpoch?: unknown }).runEpoch;
  if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) {
    throw new Error("Schedule target returned an invalid run epoch");
  }
  return epoch as number;
}

/** Read terminal run identity and optional usage from an awaited wrapper result.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function parseDispatchResult(result: unknown, expectedRunId: string, expectedEpoch: number): ScheduleDispatchResult {
  if (!result || typeof result !== "object") throw new Error("Scheduled prompt returned no terminal result");
  const value = result as {
    runId?: unknown;
    runEpoch?: unknown;
    usage?: { inputTokens?: unknown; outputTokens?: unknown; costUsd?: unknown };
  };
  if (value.runId !== expectedRunId || value.runEpoch !== expectedEpoch) {
    throw new Error("Scheduled prompt terminal identity does not match its claim");
  }
  const usage = value.usage;
  if (!usage) return { runId: expectedRunId, runEpoch: expectedEpoch };
  if (
    (usage.inputTokens !== undefined && (!Number.isSafeInteger(usage.inputTokens) || (usage.inputTokens as number) < 0))
    || (usage.outputTokens !== undefined && (!Number.isSafeInteger(usage.outputTokens) || (usage.outputTokens as number) < 0))
    || (usage.costUsd !== undefined && (
      typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
    ))
  ) {
    throw new Error("Scheduled prompt returned invalid terminal usage");
  }
  return {
    runId: expectedRunId,
    runEpoch: expectedEpoch,
    usage: {
      inputTokens: (usage.inputTokens as number | undefined) ?? 0,
      outputTokens: (usage.outputTokens as number | undefined) ?? 0,
      costUsd: usage.costUsd as number | undefined,
    },
  };
}

/** Return due unclaimed entries in chronological order for diagnostics only.
 *
 * Actual execution must use ScheduleStore.claimDue().
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
export function getDueSchedules(
  schedules: readonly PersistentSchedule[],
  now: number,
): PersistentSchedule[] {
  return schedules
    .filter((schedule) => (
      schedule.enabled
      && schedule.state === "scheduled"
      && schedule.source === "persistent"
      && Number.isSafeInteger(schedule.nextFireAt)
      && schedule.nextFireAt <= now
    ))
    .sort((left, right) => left.nextFireAt - right.nextFireAt);
}

/** Submit one claimed schedule as an exact, awaited, run-scoped command.
 *
 * Returns null while the target is busy so the claim can be released without
 * consuming an attempt.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
export async function dispatchScheduleToAgent(
  schedule: PersistentSchedule,
  agent: ScheduleAgent,
  timeoutMs: number = SCHEDULE_RUN_TIMEOUT_MS,
  cancelConfirmationMs: number = 5_000,
  onRunObserved?: ScheduleRunObserved,
): Promise<ScheduleDispatchResult | null> {
  if (!schedule.claim) throw new Error(`Schedule '${schedule.id}' has no active claim`);
  if (agent.isRunning() || agent.isOrchestratedWorker?.()) return null;
  if (agent.sessionFile !== schedule.target.sessionFile) {
    throw new Error("Schedule target wrapper does not match the persisted Session file");
  }
  if (agent.sessionFileKey !== schedule.target.fileKey) {
    throw new Error("Schedule target wrapper physical identity/file key does not match");
  }
  const state = await agent.send({ type: "get_state" });
  const runEpoch = stateRunEpoch(state) + 1;
  const runId = schedule.claim.runId;
  const terminal: Promise<ScheduleRunTerminalOutcome> = agent.send({
    type: "scheduled_prompt",
    message: schedule.prompt,
    runId,
    runEpoch,
    toolNames: [...schedule.policy.toolNames],
    modelProvider: schedule.policy.model?.provider,
    modelId: schedule.policy.model?.modelId,
    thinkingLevel: schedule.policy.thinkingLevel,
    endpointFingerprint: schedule.policy.endpointFingerprint,
  }).then(
    (value): ScheduleRunTerminalOutcome => {
      try {
        return { status: "succeeded", result: parseDispatchResult(value, runId, runEpoch) };
      } catch (error) {
        return { status: "failed", error };
      }
    },
    (error): ScheduleRunTerminalOutcome => ({ status: "failed", error }),
  );
  const observer: ScheduleRunObserver = {
    runId,
    runEpoch,
    terminal,
    requestCancel: async () => {
      const response = await agent.send({ type: "cancel_run", runId, runEpoch });
      if (
        response
        && typeof response === "object"
        && (response as { cancelled?: unknown }).cancelled === false
      ) {
        throw new Error(`Scheduled run ${runId}/${runEpoch} is no longer cancellable`);
      }
    },
  };
  onRunObserved?.(observer);
  let initialTimer: ReturnType<typeof setTimeout> | undefined;
  const initial = await Promise.race([
    terminal,
    new Promise<{ status: "timeout" }>((resolveTimeout) => {
      initialTimer = setTimeout(() => resolveTimeout({ status: "timeout" }), timeoutMs);
    }),
  ]);
  if (initialTimer) clearTimeout(initialTimer);
  if (initial.status === "succeeded") return initial.result;
  if (initial.status === "failed") throw initial.error;

  void observer.requestCancel().catch(() => undefined);
  let confirmationTimer: ReturnType<typeof setTimeout> | undefined;
  const confirmed = await Promise.race([
    terminal,
    new Promise<{ status: "unconfirmed" }>((resolveUnknown) => {
      confirmationTimer = setTimeout(() => resolveUnknown({ status: "unconfirmed" }), cancelConfirmationMs);
    }),
  ]);
  if (confirmationTimer) clearTimeout(confirmationTimer);
  if (confirmed.status === "succeeded") return confirmed.result;
  if (confirmed.status === "failed") throw confirmed.error;
  throw new ScheduleRunTerminalUnconfirmedError(observer);
}
