import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // Idle sessions report as not running. Orchestrated workers are never
    // cold-started through this read-only route either.
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
