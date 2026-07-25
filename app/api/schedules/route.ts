/**
 * Schedules API — CRUD for recurring prompt schedules.
 *
 * Reads/writes ~/.pi/agent/schedules.json (same file the cron extension uses).
 *
 * GET  /api/schedules          → list all schedules
 * POST /api/schedules          → add/update a schedule or wake the dispatcher
 * DELETE /api/schedules?id=... → cancel a schedule by ID
 *
 * @author OpenAI Codex
 * @version 2.0.0
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
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
const scheduleRuntime = globalThis as typeof globalThis & { __piScheduleDispatching?: boolean };

// ── Helpers ────────────────────────────────────────────────────────────────

/** Resolve the schedules file path under ~/.pi/agent/ */
function getSchedulesPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    || join(homedir(), ".pi", "agent");
  return join(agentDir, "schedules.json");
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
    const now = Date.now();
    const store = await readStore();
    const dueSchedules = getDueSchedules(store.schedules, now);

    for (const schedule of dueSchedules) {
      const sessionId = schedule.sessionId;
      if (!sessionId) continue;
      let agent = getRpcSession(sessionId);
      if (!agent?.isAlive()) {
        const filePath = await resolveSessionPath(sessionId);
        if (!filePath) continue;
        const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();
        ({ session: agent } = await startRpcSession(sessionId, filePath, cwd));
      }

      if (!await dispatchScheduleToAgent(schedule, agent)) continue;

      const latestStore = await readStore();
      const completed = latestStore.schedules.find((entry) => (
        entry.id === schedule.id && entry.nextFireAt === schedule.nextFireAt
      ));
      if (completed) {
        completed.nextFireAt = now + completed.intervalSeconds * 1000;
        completed.fireCount += 1;
        completed.lastFiredAt = now;
        await writeStore(latestStore);
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
  } finally {
    scheduleRuntime.__piScheduleDispatching = false;
  }
}

// ── Route Handler ──────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const store = await readStore();
    return Response.json({ schedules: store.schedules });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json().catch(() => ({})) as {
      action?: "dispatchDue";
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

    if (body.action === "dispatchDue") return dispatchDueSchedule();
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(body.thinkingLevel)) {
      return Response.json({ error: `Unsupported thinkingLevel '${body.thinkingLevel}'` }, { status: 400 });
    }

    const store = await readStore();

    // If id is provided, update the existing schedule (e.g., after a fire)
    if (body.id) {
      const idx = store.schedules.findIndex((s) => s.id === body.id);
      if (idx === -1) {
        return Response.json({ error: `Schedule '${body.id}' not found` }, { status: 404 });
      }
      if (body.nextFireAt !== undefined) store.schedules[idx].nextFireAt = body.nextFireAt;
      if (body.enabled !== undefined) store.schedules[idx].enabled = body.enabled;
      if (body.fireCount !== undefined) store.schedules[idx].fireCount = body.fireCount;
      if (body.modelProvider !== undefined) store.schedules[idx].modelProvider = body.modelProvider || undefined;
      if (body.modelId !== undefined) store.schedules[idx].modelId = body.modelId || undefined;
      if (body.thinkingLevel !== undefined) store.schedules[idx].thinkingLevel = body.thinkingLevel || undefined;
      if (body.sessionId !== undefined) store.schedules[idx].sessionId = body.sessionId || undefined;
      store.schedules[idx].lastFiredAt = Date.now();
      await writeStore(store);
      return Response.json({ schedule: store.schedules[idx] });
    }

    // Otherwise, create a new schedule
    // Validate required fields
    if (!body.intervalSeconds || typeof body.intervalSeconds !== "number" || body.intervalSeconds < 10) {
      return Response.json(
        { error: "intervalSeconds must be a number >= 10" },
        { status: 400 },
      );
    }
    if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
      return Response.json(
        { error: "prompt is required and must be a non-empty string" },
        { status: 400 },
      );
    }
    if (!body.sessionId || typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      return Response.json(
        { error: "sessionId is required for a schedule" },
        { status: 400 },
      );
    }
    if (Boolean(body.modelProvider) !== Boolean(body.modelId)) {
      return Response.json(
        { error: "modelProvider and modelId must be provided together" },
        { status: 400 },
      );
    }

    // Cap at 50 schedules
    if (store.schedules.length >= 50) {
      return Response.json(
        { error: "Maximum of 50 schedules reached" },
        { status: 400 },
      );
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
      modelProvider: body.modelProvider || undefined,
      modelId: body.modelId || undefined,
      thinkingLevel: body.thinkingLevel || undefined,
      sessionId: body.sessionId.trim(),
    };

    store.schedules.push(entry);
    await writeStore(store);

    return Response.json({ schedule: entry }, { status: 201 });
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

    const store = await readStore();
    const idx = store.schedules.findIndex((s) => s.id === id);
    if (idx === -1) {
      return Response.json({ error: `Schedule '${id}' not found` }, { status: 404 });
    }

    const removed = store.schedules[idx];
    store.schedules.splice(idx, 1);
    await writeStore(store);

    return Response.json({ removed });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
