import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (SessionManager.open(filePath).getHeader()?.orchestration !== undefined) {
      // Read-only state of a live worker is observable; never start one here.
      const worker = getRpcSession(id);
      if (!worker?.isAlive()) return NextResponse.json({ running: false });
      const workerState = await worker.send({ type: "get_state" });
      return NextResponse.json({ running: true, state: workerState });
    }

    const rpc = getRpcSession(id);
    if (!rpc?.isAlive()) return NextResponse.json({ running: false });

    const state = await rpc.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
