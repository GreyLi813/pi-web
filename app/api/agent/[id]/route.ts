import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { verifySessionTarget } from "@earendil-works/pi-coding-agent";
import { assertGenericSessionMutationAllowed } from "@/lib/model-controlled-session";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcRuntimeInstanceId, startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";

/** Reject generic routes that would bypass durable controller ownership.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function controlledRouteRejection(): NextResponse {
  return NextResponse.json(
    { error: "Peer Sessions can only be accessed through peer owner authority; orchestrated workers can only be accessed through their owning controller Session" },
    { status: 403 },
  );
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (body.type === "set_tools") {
      if (existing?.isAlive() && existing.isRestrictedModelControlledSession()) {
        return controlledRouteRejection();
      }
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      if (!existing?.isAlive()) {
        if (!filePath) {
          return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }
        // Generic routes must never cold-start a controlled session.
        const target = await verifySessionTarget({ sessionId: id, sessionFile: filePath });
        try {
          await assertGenericSessionMutationAllowed(target, "accessed");
        } catch {
          return controlledRouteRejection();
        }
      }
      const changed = await setRpcSessionTools(id, filePath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      if (existing.isRestrictedModelControlledSession()) return controlledRouteRejection();
      // A freshly ensured Session defers its first persist until the first
      // assistant response, so sessionFile can be a planned path that does not
      // exist on disk yet. Its identity was already leased at startup; only
      // verify files that actually exist.
      if (existing.sessionFile && existsSync(existing.sessionFile)) {
        const target = await verifySessionTarget({ sessionId: id, sessionFile: existing.sessionFile });
        try {
          await assertGenericSessionMutationAllowed(target, "accessed");
        } catch {
          return controlledRouteRejection();
        }
      }
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    let session;
    try {
      ({ session } = await startRpcSession(id, filePath, undefined, {
        ...(toolNames !== undefined ? { toolNames } : {}),
      }));
    } catch (error) {
      if (error instanceof Error && /owning controller|controller authority/.test(error.message)) {
        return controlledRouteRejection();
      }
      throw error;
    }
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false, runtimeInstanceId: getRpcRuntimeInstanceId() });
    }

    // Read-only observation of a live worker is allowed: its JSONL is already
    // browsable in this local UI. Only mutation/startup paths stay forbidden.
    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, runtimeInstanceId: getRpcRuntimeInstanceId(), state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
