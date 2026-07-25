export interface PersistentSchedule {
  id: string;
  intervalSeconds: number;
  prompt: string;
  nextFireAt: number;
  enabled: boolean;
  source: string;
  fireCount: number;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export interface ScheduleAgent {
  isRunning(): boolean;
  send(command: Record<string, unknown>): Promise<unknown>;
}

/** Return bound persistent schedules that are due, oldest first.
 *
 * Unbound legacy tasks cannot be executed safely and are excluded.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export function getDueSchedules(
  schedules: readonly PersistentSchedule[],
  now: number,
): PersistentSchedule[] {
  return schedules
    .filter((schedule) => (
      schedule.enabled
      && schedule.source === "persistent"
      && Boolean(schedule.sessionId)
      && Number.isFinite(schedule.nextFireAt)
      && schedule.nextFireAt <= now
    ))
    .sort((left, right) => left.nextFireAt - right.nextFireAt);
}

/** Apply schedule settings and submit its prompt to one exact session agent.
 *
 * Returns false while that session is busy so its due time remains unchanged.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function dispatchScheduleToAgent(
  schedule: PersistentSchedule,
  agent: ScheduleAgent,
): Promise<boolean> {
  if (!schedule.sessionId || agent.isRunning()) return false;
  if (Boolean(schedule.modelProvider) !== Boolean(schedule.modelId)) {
    throw new Error(`Schedule '${schedule.id}' has an incomplete model configuration`);
  }

  await agent.send({
    type: "scheduled_prompt",
    message: schedule.prompt,
    ...(schedule.modelProvider && schedule.modelId
      ? { modelProvider: schedule.modelProvider, modelId: schedule.modelId }
      : {}),
    ...(schedule.thinkingLevel && schedule.thinkingLevel !== "auto"
      ? { thinkingLevel: schedule.thinkingLevel }
      : {}),
  });
  return true;
}
