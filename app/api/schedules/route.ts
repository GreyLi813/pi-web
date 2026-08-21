/**
 * Strict ScheduleStore CRUD plus optional server-scheduler wake-up.
 *
 * @author GPT-5.6 Sol
 * @version 4.0.0
 */

import {
  getAgentDir,
  PeerAuthorityStore,
  ScheduleStore,
  type ScheduleBudget,
  type ScheduleEntry,
  type ScheduleRuntimePolicy,
  storeSessionTarget,
  verifySessionTarget,
  verifyStoredSessionTarget,
} from "@earendil-works/pi-coding-agent";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import {
  requestPersistentScheduleRunCancel,
  wakePersistentSessionScheduler,
} from "@/lib/session-scheduler";

export const dynamic = "force-dynamic";

const THINKING_LEVELS = new Set(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SCHEDULE_ACTIONS = new Set(["dispatchDue", "pause", "cancel", "resume", "update", "reauthorize"]);

interface ScheduleRequestBody {
  action?: "dispatchDue" | "pause" | "cancel" | "resume" | "update" | "reauthorize";
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
  maxCalls?: number;
  maxConcurrentRuns?: number;
  maxRetries?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
}

interface SchedulePolicyResponse {
  version: 1;
  toolNames: string[];
  model?: { provider: string; modelId: string };
  thinkingLevel: ScheduleRuntimePolicy["thinkingLevel"];
  endpointFingerprint?: string;
}

/** Return the one ScheduleStore bound to the explicit active Agent directory.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function scheduleStore(): ScheduleStore {
  return new ScheduleStore(getAgentDir());
}

/** Project strict internal fields into the existing panel's flat display shape.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function publicSchedule(schedule: ScheduleEntry): ScheduleEntry & {
  sessionId: string;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel: string;
} {
  return {
    ...schedule,
    sessionId: schedule.target.sessionId,
    modelProvider: schedule.policy.model?.provider,
    modelId: schedule.policy.model?.modelId,
    thinkingLevel: schedule.policy.thinkingLevel,
  };
}

/** Convert a thrown store/validation error to a stable HTTP status.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = /peer Sessions can only be scheduled through their owning controller/i.test(message)
    ? 403
    : /not found/i.test(message)
      ? 404
      : /Pause the schedule|cannot be changed|cannot be removed|cannot resume|active in another process|live pending-run monitor|no longer cancellable/i.test(message)
        ? 409
        : /invalid JSON|Unsupported ScheduleStore version|Schedule store|Schedule entry|claim state is inconsistent|enabled state is inconsistent/i.test(message)
          ? 500
          : 400;
  return Response.json({ error: message }, { status });
}

/** Require a finite safe integer at the HTTP boundary.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function safeInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

/** Validate paired model fields and supported Thinking input.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function validatePolicySelection(body: ScheduleRequestBody): void {
  if (Boolean(body.modelProvider?.trim()) !== Boolean(body.modelId?.trim())) {
    throw new Error("modelProvider and modelId must be provided together");
  }
  if (body.thinkingLevel !== undefined && !THINKING_LEVELS.has(body.thinkingLevel)) {
    throw new Error(`Unsupported thinkingLevel '${body.thinkingLevel}'`);
  }
}

/** Parse optional hard budgets while leaving token/cost fields reserved and enforced.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function requestBudget(body: ScheduleRequestBody): Partial<ScheduleBudget> | undefined {
  const values = {
    maxCalls: body.maxCalls,
    maxConcurrentRuns: body.maxConcurrentRuns,
    maxRetries: body.maxRetries,
    maxInputTokens: body.maxInputTokens,
    maxOutputTokens: body.maxOutputTokens,
    maxCostUsd: body.maxCostUsd,
  };
  return Object.values(values).some((value) => value !== undefined) ? values : undefined;
}

/** Resolve and securely verify one exact non-worker Session target.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function verifyScheduleTarget(sessionId: string) {
  const sessionFile = await resolveSessionPath(sessionId);
  if (!sessionFile) throw new Error(`Session '${sessionId}' not found`);
  const target = await verifySessionTarget({
    sessionId,
    sessionFile,
    cwd: undefined,
  });
  if (target.header.orchestration !== undefined) {
    throw new Error("Orchestrated workers cannot own schedules");
  }
  if (target.header.peer !== undefined) {
    throw new Error("Peer Sessions can only be scheduled through their owning controller authority");
  }
  return target;
}

/** Reject generic mutations of schedules governed by peer host authority.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function assertGenericScheduleMutationAllowed(schedule: ScheduleEntry): Promise<void> {
  if (schedule.peerAuthorityId) {
    throw new Error("Peer Sessions can only be scheduled through their owning controller authority");
  }
  const authority = await new PeerAuthorityStore(getAgentDir()).read();
  if (authority.authorities.some((entry) => entry.peerTarget.fileKey === schedule.target.fileKey)) {
    throw new Error("Peer Sessions can only be scheduled through their owning controller authority");
  }
  try {
    const target = await verifyStoredSessionTarget(schedule.target);
    if (target.header.peer !== undefined) {
      throw new Error("Peer Sessions can only be scheduled through their owning controller authority");
    }
  } catch (error) {
    if (/Peer Sessions can only/.test(error instanceof Error ? error.message : String(error))) throw error;
    // A missing ordinary target may still be paused or removed safely.
  }
}

/** Capture exact tools/model/Thinking/endpoint, using no-tools for a cold ordinary Session.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function captureSchedulePolicy(
  target: Awaited<ReturnType<typeof verifyScheduleTarget>>,
  body: Pick<ScheduleRequestBody, "modelProvider" | "modelId" | "thinkingLevel">,
): Promise<ScheduleRuntimePolicy> {
  validatePolicySelection(body);
  let agent = getRpcSession(target.sessionId);
  if (!agent?.isAlive()) {
    ({ session: agent } = await startRpcSession(
      target.sessionId,
      target.sessionFile,
      target.cwd,
      {
        expectedSessionTarget: storeSessionTarget(target),
        toolNames: [],
        includeExtensionTools: false,
        preserveSystemPromptWithoutTools: true,
      },
    ));
  }
  if (agent.sessionFile !== target.sessionFile) throw new Error("Schedule target wrapper identity does not match");
  const policy = await agent.send({
    type: "get_schedule_policy",
    modelProvider: body.modelProvider?.trim() || undefined,
    modelId: body.modelId?.trim() || undefined,
    thinkingLevel: body.thinkingLevel ?? "auto",
  }) as SchedulePolicyResponse;
  return {
    version: 1,
    toolNames: [...policy.toolNames],
    model: policy.model,
    thinkingLevel: policy.thinkingLevel,
    endpointFingerprint: policy.endpointFingerprint,
  };
}

/** List all schedules without converting corrupt storage into an empty result.
 *
 * @author GPT-5.6 Sol
 * @version 4.0.0
 */
export async function GET(): Promise<Response> {
  try {
    const store = await scheduleStore().read();
    return Response.json({ schedules: store.schedules.map(publicSchedule) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Create, pause, resume, update, or wake strict persistent schedules.
 *
 * @author GPT-5.6 Sol
 * @version 4.0.0
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({})) as ScheduleRequestBody;
    if (body.action !== undefined && !SCHEDULE_ACTIONS.has(body.action)) {
      throw new Error(`Unsupported action '${body.action}'`);
    }
    if (body.action === "dispatchDue") {
      const result = await wakePersistentSessionScheduler();
      return Response.json({ dispatched: result.succeeded > 0, ...result });
    }
    const store = scheduleStore();
    if (body.action) {
      if (!body.id?.trim()) throw new Error(`action '${body.action}' requires an id`);
      const current = (await store.read()).schedules.find((entry) => entry.id === body.id);
      if (!current) throw new Error(`Schedule '${body.id}' not found`);
      await assertGenericScheduleMutationAllowed(current);
      if (body.action === "pause") {
        return Response.json({ schedule: publicSchedule(await store.pause(body.id)) });
      }
      if (body.action === "cancel") {
        if (
          !current.claim
          || (current.state !== "running" && current.state !== "pending-terminal")
        ) {
          throw new Error("Only a running Schedule can be cancelled");
        }
        const paused = await store.pause(body.id, "Cancellation requested by user");
        const requested = await requestPersistentScheduleRunCancel(body.id, current.claim.runId);
        if (!requested) {
          throw new Error("Schedule has no live pending-run monitor; it remains paused and will not auto-retry");
        }
        return Response.json({ schedule: publicSchedule(paused), cancelRequested: true });
      }
      if (body.action === "resume") {
        return Response.json({ schedule: publicSchedule(await store.resume(body.id)) });
      }
      if (body.action === "reauthorize") {
        if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
          throw new Error("Schedule re-authorization requires sessionId");
        }
        const target = await verifyScheduleTarget(body.sessionId.trim());
        const policy = await captureSchedulePolicy(target, body);
        return Response.json({ schedule: publicSchedule(await store.reauthorize(body.id, target, policy)) });
      }
      if (body.enabled !== undefined || body.nextFireAt !== undefined || body.fireCount !== undefined || body.sessionId !== undefined) {
        throw new Error("enabled, nextFireAt, fireCount, and Session binding cannot be changed");
      }
      const changes: Parameters<ScheduleStore["update"]>[1] = {};
      if (body.intervalSeconds !== undefined) {
        changes.intervalSeconds = safeInteger(body.intervalSeconds, "intervalSeconds", 10, 31_536_000);
      }
      if (body.prompt !== undefined) {
        if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt must be non-empty");
        changes.prompt = body.prompt.trim();
      }
      if (body.modelProvider !== undefined || body.modelId !== undefined || body.thinkingLevel !== undefined) {
        const target = await verifyScheduleTarget(current.target.sessionId);
        if (target.sessionFile !== current.target.sessionFile) throw new Error("Schedule target identity changed");
        changes.policy = await captureSchedulePolicy(target, body);
      }
      const updated = await store.update(body.id, changes);
      return Response.json({ schedule: publicSchedule(updated) });
    }

    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) throw new Error("sessionId is required");
    if (body.fireCount !== undefined || body.id !== undefined) throw new Error("id and fireCount are managed by ScheduleStore");
    const intervalSeconds = safeInteger(body.intervalSeconds, "intervalSeconds", 10, 31_536_000);
    if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required and must be non-empty");
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
    const nextFireAt = body.nextFireAt === undefined
      ? undefined
      : safeInteger(body.nextFireAt, "nextFireAt", 0, Number.MAX_SAFE_INTEGER);
    validatePolicySelection(body);
    const target = await verifyScheduleTarget(body.sessionId.trim());
    const policy = await captureSchedulePolicy(target, body);
    const created = await store.create({
      target,
      intervalSeconds,
      prompt: body.prompt.trim(),
      policy,
      nextFireAt,
      enabled: body.enabled,
      budget: requestBudget(body),
    });
    void wakePersistentSessionScheduler();
    return Response.json({ schedule: publicSchedule(created) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Delete one schedule under the shared cross-process store lock.
 *
 * @author GPT-5.6 Sol
 * @version 4.0.0
 */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new Error("Missing ?id= parameter");
    const store = scheduleStore();
    const current = (await store.read()).schedules.find((entry) => entry.id === id);
    if (!current) throw new Error(`Schedule '${id}' not found`);
    await assertGenericScheduleMutationAllowed(current);
    return Response.json({ removed: publicSchedule(await store.remove(id)) });
  } catch (error) {
    return errorResponse(error);
  }
}
