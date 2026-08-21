export const DEFAULT_SCHEDULE_SESSION_NAME = "Scheduled tasks";

interface EnsureScheduleSessionOptions {
  runtimeSessionId: string | null;
  persistedSessionId: string | null;
  createSession: () => Promise<string | null>;
  persistSession: (sessionId: string) => Promise<void>;
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
  runtimeSessionId,
  persistedSessionId,
  createSession,
  persistSession,
  initializeSession,
  promoteSession,
}: EnsureScheduleSessionOptions): Promise<string | null> {
  if (persistedSessionId) return persistedSessionId;

  const createdSessionId = runtimeSessionId ?? await createSession();
  if (!createdSessionId) return null;

  // Persistence is the transaction boundary: SSE, naming, promotion, and
  // schedule creation must never observe an in-memory-only Session ID.
  await persistSession(createdSessionId);
  await initializeSession(createdSessionId);
  promoteSession(createdSessionId);
  return createdSessionId;
}
