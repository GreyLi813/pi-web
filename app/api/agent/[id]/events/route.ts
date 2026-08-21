import { verifySessionTarget } from "@earendil-works/pi-coding-agent";
import { createAgentEventStream, type AgentEventStreamSession } from "@/lib/agent-event-stream";
import { isModelControlledSessionTarget } from "@/lib/model-controlled-session";
import { getRpcRuntimeInstanceId, getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  // Fast path: attach to a live session. Live workers and peers remain
  // observable read-only, but this generic route may not cold-start them.
  const live = getRpcSession(id);
  let sessionPromise: Promise<AgentEventStreamSession>;
  if (live?.isAlive()) {
    sessionPromise = Promise.resolve(live);
  } else {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return new Response("Session not found", { status: 404 });
    const target = await verifySessionTarget({ sessionId: id, sessionFile: filePath });
    if (await isModelControlledSessionTarget(target)) {
      return new Response("Idle model-controlled Sessions require their owning controller authority", {
        status: 403,
      });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = startRpcSession(id, filePath, undefined).then((result) => result.session);
  }

  const stream = createAgentEventStream(req, id, sessionPromise, {
    runtimeInstanceId: getRpcRuntimeInstanceId(),
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
