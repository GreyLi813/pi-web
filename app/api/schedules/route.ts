/**
 * Schedules API — CRUD for recurring prompt schedules.
 *
 * Reads/writes ~/.pi/agent/schedules.json (same file the cron extension uses).
 *
 * GET  /api/schedules          → list all schedules
 * POST /api/schedules          → create, pause, edit, resume, bind, or dispatch
 * DELETE /api/schedules?id=... → cancel a schedule by ID
 *
 * @author OpenAI Codex
 * @version 3.0.0
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import {
  dispatchScheduleToAgent,
  getDueSchedules,
  type PersistentSchedule,
} from "@/lib/schedule-dispatch";

export const dynamic = "force-dynamic";

// ── Types ──────────────────────────────────────────────────────────────────

interface ScheduleEntry extends PersistentSchedule {
  createdAt: number;
  lastFiredAt?: number;
}

interface PersistentStore {
  version: number;
  schedules: ScheduleEntry[];
  updatedAt: number;
}

const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SCHEDULE_ACTIONS = new Set(["dispatchDue", "pause", "resume", "update"]);

type ScheduleRequestBody = {
  action?: "dispatchDue" | "pause" | "resume" | "update";
  id?: string;
  intervalSeconds?: number;
  prompt?: string;
  enabled?: boolean;
  nextFireAt?: number;
  fireCount?: number;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
  sessionId?: string;
};

type ScheduleRuntime = typeof globalThis & {
  __piScheduleDispatching?: boolean;
  __piScheduleMutationTail?: Promise<void>;
};

const scheduleRuntime = globalThis as ScheduleRuntime;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the schedules file path under the active Pi Agent directory. */
function getSchedulesPath(): string {
  return join(getAgentDir(), "schedules.json");
}

/** Read the persistent schedules store. Returns empty array on any error. */
async function readStore(): Promise<PersistentStore> {
  try {
    const filePath = getSchedulesPath();
    const raw = await readFile(filePath, "utf-8");
    const store = JSON.parse(raw) as PersistentStore;
    if (!store || store.version !== 1 || !Array.isArray(store.schedules)) {
      return { version: 1, schedules: [], updatedAt: Date.now() };
    }
    return store;
  } catch {
    return { version: 1, schedules: [], updatedAt: Date.now() };
  }
}

/** Write the persistent schedules store to disk. */
async function writeStore(store: PersistentStore): Promise<void> {
  const filePath = getSchedulesPath();
  try { await mkdir(dirname(filePath), { recursive: true }); } catch { /* ok */ }
  store.updatedAt = Date.now();
  await writeFile(filePath, JSON.stringify(store, null, 2), "utf-8");
}

/** Serialize schedule-store reads and writes within this server process. */
async function withScheduleStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = scheduleRuntime.__piScheduleMutationTail ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = () => resolve(); });
  const tail = previous.then(() => gate);
  scheduleRuntime.__piScheduleMutationTail = tail;

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (scheduleRuntime.__piScheduleMutationTail === tail) {
      scheduleRuntime.__piScheduleMutationTail = undefined;
    }
  }
}

/** Validate that a durable schedule target exists and is a controller Session.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function validateScheduleTarget(sessionId: string): Promise<string | undefined> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return `Session '${sessionId}' not found`;
  if (readSessionHeader(filePath)?.orchestration !== undefined) {
    return "Orchestrated worker sessions cannot own schedules";
  }
  return undefined;
}

/** Return a validation error when only half of a model selection is provided. */
function validateModelSelection(modelProvider: string | undefined, modelId: string | undefined): string | null {
  if (Boolean(modelProvider?.trim()) !== Boolean(modelId?.trim())) {
    return "modelProvider and modelId must be provided together";
  }
  return null;
}

/** Dispatch one due task to the session stored on that task.
 *
 * The global lock prevents duplicate dispatch when several browser tabs poll
 * simultaneously. Busy sessions retain their due task for a later poll.
 *
 * @author OpenAI Codex
 * @version 1.0.0
 */
async function dispatchDueSchedule(): Promise<Response> {
  if (scheduleRuntime.__piScheduleDispatching) {
    return Response.json({ dispatched: false, reason: "dispatcher_busy" }, { status: 202 });
  }
  scheduleRuntime.__piScheduleDispatching = true;

  try {
    return await withScheduleStoreLock(async () => {
      const now = Date.now();
      const store = await readStore();
      const dueSchedules = getDueSchedules(store.schedules, now);

      for (const schedule of dueSchedules) {
        const sessionId = schedule.sessionId;
        if (!sessionId) continue;
        const filePath = await resolveSessionPath(sessionId);
        if (!filePath) {
          const stored = store.schedules.find((entry) => entry.id === schedule.id);
          if (stored?.enabled) {
            stored.enabled = false;
            await writeStore(store);
          }
          continue;
        }
        const header = readSessionHeader(filePath);
        if (header?.orchestration !== undefined) {
          const stored = store.schedules.find((entry) => entry.id === schedule.id);
          if (stored?.enabled) {
            stored.enabled = false;
            await writeStore(store);
          }
          continue;
        }

        let agent = getRpcSession(sessionId);
        if (!agent?.isAlive()) {
          const cwd = header?.cwd ?? process.cwd();
          ({ session: agent } = await startRpcSession(sessionId, filePath, cwd));
        }

        if (!await dispatchScheduleToAgent(schedule, agent)) continue;

        const completed = store.schedules.find((entry) => (
          entry.id === schedule.id && entry.nextFireAt === schedule.nextFireAt
        ));
        if (completed) {
          completed.nextFireAt = now + completed.intervalSeconds * 1000;
          completed.fireCount += 1;
          completed.lastFiredAt = now;
          await writeStore(store);
        }

        return Response.json({
          dispatched: true,
          scheduleId: schedule.id,
          sessionId,
          modelProvider: schedule.modelProvider,
          modelId: schedule.modelId,
          thinkingLevel: schedule.thinkingLevel,
        });
      }

      return Response.json({ dispatched: false, reason: "no_ready_schedule" });
    });
  } finally {
    scheduleRuntime.__piScheduleDispatching = false;
  }
}

// ── Route Handler ──────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    return await withScheduleStoreLock(async () => {
      const store = await readStore();
      return Response.json({ schedules: store.schedules });
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({})) as ScheduleRequestBody;

    if (body.action !== undefined && !SCHEDULE_ACTIONS.has(body.action)) {
      return Response.json({ error: `Unsupported action '${body.action}'` }, { status: 400 });
    }
    if (body.action === "dispatchDue") return dispatchDueSchedule();
    if (body.action && !body.id) {
      return Response.json({ error: `action '${body.action}' requires an id` }, { status: 400 });
    }
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(body.thinkingLevel)) {
      return Response.json({ error: `Unsupported thinkingLevel '${body.thinkingLevel}'` }, { status: 400 });
    }

    return await withScheduleStoreLock(async () => {
      const store = await readStore();

      if (body.id) {
        const schedule = store.schedules.find((entry) => entry.id === body.id);
        if (!schedule) {
          return Response.json({ error: `Schedule '${body.id}' not found` }, { status: 404 });
        }

        if (body.action === "pause") {
          if (schedule.enabled) {
            schedule.enabled = false;
            await writeStore(store);
          }
          return Response.json({ schedule });
        }

        if (body.action === "resume") {
          const targetError = schedule.sessionId
            ? await validateScheduleTarget(schedule.sessionId)
            : "Schedule has no bound Session";
          if (targetError) {
            schedule.enabled = false;
            await writeStore(store);
            return Response.json({ error: targetError }, { status: 409 });
          }
          if (!schedule.enabled) {
            schedule.enabled = true;
            schedule.nextFireAt = Date.now() + schedule.intervalSeconds * 1000;
            await writeStore(store);
          }
          return Response.json({ schedule });
        }

        if (body.action === "update") {
          if (schedule.enabled) {
            return Response.json({ error: "Pause the schedule before editing it" }, { status: 409 });
          }
          if (body.sessionId !== undefined) {
            return Response.json({ error: "A schedule's session binding cannot be changed" }, { status: 400 });
          }
          if (body.enabled !== undefined || body.nextFireAt !== undefined || body.fireCount !== undefined) {
            return Response.json({ error: "enabled, nextFireAt, and fireCount are managed by pause/resume/dispatch" }, { status: 400 });
          }
          if (body.intervalSeconds !== undefined && (
            typeof body.intervalSeconds !== "number" || body.intervalSeconds < 10
          )) {
            return Response.json({ error: "intervalSeconds must be a number >= 10" }, { status: 400 });
          }
          if (body.prompt !== undefined && (typeof body.prompt !== "string" || !body.prompt.trim())) {
            return Response.json({ error: "prompt must be a non-empty string" }, { status: 400 });
          }

          const modelFieldsProvided = body.modelProvider !== undefined || body.modelId !== undefined;
          const modelError = modelFieldsProvided
            ? validateModelSelection(body.modelProvider, body.modelId)
            : null;
          if (modelError) return Response.json({ error: modelError }, { status: 400 });

          const hasEditableField = body.intervalSeconds !== undefined
            || body.prompt !== undefined
            || modelFieldsProvided
            || body.thinkingLevel !== undefined;
          if (!hasEditableField) {
            return Response.json({ error: "No editable schedule fields were provided" }, { status: 400 });
          }

          if (body.intervalSeconds !== undefined) schedule.intervalSeconds = body.intervalSeconds;
          if (body.prompt !== undefined) schedule.prompt = body.prompt.trim();
          if (modelFieldsProvided) {
            schedule.modelProvider = body.modelProvider?.trim() || undefined;
            schedule.modelId = body.modelId?.trim() || undefined;
          }
          if (body.thinkingLevel !== undefined) {
            schedule.thinkingLevel = body.thinkingLevel === "auto" ? undefined : body.thinkingLevel;
          }
          await writeStore(store);
          return Response.json({ schedule });
        }

        // Legacy schedules may be bound once, but ownership is immutable afterwards.
        if (body.sessionId !== undefined) {
          const requestedSessionId = body.sessionId.trim();
          if (!requestedSessionId) {
            return Response.json({ error: "sessionId must be a non-empty string" }, { status: 400 });
          }
          if (schedule.sessionId && schedule.sessionId !== requestedSessionId) {
            return Response.json({ error: "A schedule's session binding cannot be changed" }, { status: 409 });
          }
          if (!schedule.sessionId) {
            const targetError = await validateScheduleTarget(requestedSessionId);
            if (targetError) return Response.json({ error: targetError }, { status: 400 });
            schedule.sessionId = requestedSessionId;
            await writeStore(store);
          }
          return Response.json({ schedule });
        }

        return Response.json({ error: "An update action is required" }, { status: 400 });
      }

      if (!body.intervalSeconds || typeof body.intervalSeconds !== "number" || body.intervalSeconds < 10) {
        return Response.json({ error: "intervalSeconds must be a number >= 10" }, { status: 400 });
      }
      if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return Response.json({ error: "prompt is required and must be a non-empty string" }, { status: 400 });
      }
      if (!body.sessionId || typeof body.sessionId !== "string" || !body.sessionId.trim()) {
        return Response.json({ error: "sessionId is required for a schedule" }, { status: 400 });
      }

      const modelError = validateModelSelection(body.modelProvider, body.modelId);
      if (modelError) return Response.json({ error: modelError }, { status: 400 });
      const targetError = await validateScheduleTarget(body.sessionId.trim());
      if (targetError) return Response.json({ error: targetError }, { status: 400 });
      if (store.schedules.length >= 50) {
        return Response.json({ error: "Maximum of 50 schedules reached" }, { status: 400 });
      }

      const entry: ScheduleEntry = {
        id: `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        intervalSeconds: body.intervalSeconds,
        prompt: body.prompt.trim(),
        nextFireAt: body.nextFireAt ?? (Date.now() + body.intervalSeconds * 1000),
        enabled: body.enabled !== false,
        source: "persistent",
        createdAt: Date.now(),
        fireCount: 0,
        modelProvider: body.modelProvider?.trim() || undefined,
        modelId: body.modelId?.trim() || undefined,
        thinkingLevel: body.thinkingLevel === "auto" ? undefined : body.thinkingLevel,
        sessionId: body.sessionId.trim(),
      };

      store.schedules.push(entry);
      await writeStore(store);
      return Response.json({ schedule: entry }, { status: 201 });
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ error: "Missing ?id= parameter" }, { status: 400 });
    }

    return await withScheduleStoreLock(async () => {
      const store = await readStore();
      const idx = store.schedules.findIndex((schedule) => schedule.id === id);
      if (idx === -1) {
        return Response.json({ error: `Schedule '${id}' not found` }, { status: 404 });
      }

      const removed = store.schedules[idx];
      store.schedules.splice(idx, 1);
      await writeStore(store);
      return Response.json({ removed });
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
