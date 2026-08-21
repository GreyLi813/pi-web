import { NextResponse } from "next/server";
import { storeSessionTarget, type AgentSession, verifySessionTarget } from "@earendil-works/pi-coding-agent";
import { assertGenericSessionMutationAllowed } from "@/lib/model-controlled-session";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const target = await verifySessionTarget({ sessionId: id, sessionFile: filePath });
    try {
      await assertGenericSessionMutationAllowed(target, "changed");
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 403 });
    }

    const existing = getRpcSession(id);
    if (existing?.isAlive() && existing.isRestrictedModelControlledSession()) {
      return NextResponse.json(
        { error: "Peer Sessions and orchestrated workers can only be changed through their owning controller authority" },
        { status: 403 },
      );
    }
    let session;
    try {
      ({ session } = existing?.isAlive()
        ? { session: existing }
        : await startRpcSession(id, filePath, undefined, {
            expectedSessionTarget: storeSessionTarget(target),
          }));
    } catch (error) {
      if (error instanceof Error && /owning controller|controller authority/.test(error.message)) {
        return NextResponse.json(
          { error: "Peer Sessions and orchestrated workers can only be changed through their owning controller authority" },
          { status: 403 },
        );
      }
      throw error;
    }

    if (session.isRestrictedModelControlledSession()) {
      return NextResponse.json(
        { error: "Peer Sessions and orchestrated workers can only be changed through their owning controller authority" },
        { status: 403 },
      );
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
