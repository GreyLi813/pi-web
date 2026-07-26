export const DEFAULT_SCHEDULE_SESSION_NAME = "Scheduled tasks";

interface EnsureScheduleSessionOptions {
  sessionId: string | null;
  createSession: () => Promise<string | null>;
  initializeSession: (sessionId: string) => Promise<void>;
  promoteSession: (sessionId: string) => void;
}

/** Return the active session or create and promote one for scheduled tasks.
 *
 * Session creation is delegated to the normal chat lifecycle so model, tool,
 * working-directory, and persistence behavior remain identical to a new chat.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
export async function ensureScheduleSession({
  sessionId,
  createSession,
  initializeSession,
  promoteSession,
}: EnsureScheduleSessionOptions): Promise<string | null> {
  if (sessionId) return sessionId;

  const createdSessionId = await createSession();
  if (!createdSessionId) return null;

  await initializeSession(createdSessionId);
  promoteSession(createdSessionId);
  return createdSessionId;
}
