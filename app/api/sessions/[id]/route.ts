import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  acquireOrchestratedSessionDeletionLease,
  acquireSessionFileLease,
  getAgentDir,
  isSessionOrchestrationMetadata,
  listOwnedOrchestratedSessions,
  type OrchestratedSessionDeletionLease,
  ScheduleStore,
  SessionManager,
  type SessionFileLease,
  verifySessionTarget,
  withSessionOrchestrationOwnerLock,
} from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
} from "@/lib/session-reader";
import { assertGenericSessionMutationAllowed } from "@/lib/model-controlled-session";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession, reserveRpcSessionDeletion } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
/** Re-parent direct child headers while holding each child's shared mutation lease.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function reparentDirectChildren(
  filePath: string,
  parentSessionPath: string | undefined,
): Promise<void> {
  const targetPathKey = sessionPathKey(filePath);
  const directory = dirname(filePath);
  const files = readdirSync(directory).filter(
    (file) => file.endsWith(".jsonl") && sessionPathKey(join(directory, file)) !== targetPathKey,
  );
  const childTargets = [];
  for (const file of files) {
    const childPath = join(directory, file);
    let candidate: { type?: string; id?: string; cwd?: string; parentSession?: string };
    try {
      candidate = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]);
    } catch {
      continue;
    }
    if (
      candidate.type !== "session"
      || typeof candidate.id !== "string"
      || typeof candidate.cwd !== "string"
      || !candidate.parentSession
      || sessionPathKey(candidate.parentSession) !== targetPathKey
    ) {
      continue;
    }
    childTargets.push(await verifySessionTarget({
      sessionId: candidate.id,
      sessionFile: childPath,
      sessionDir: directory,
      cwd: candidate.cwd,
    }));
  }

  const leases: SessionFileLease[] = [];
  try {
    for (const target of childTargets.sort((left, right) => left.sessionFile.localeCompare(right.sessionFile))) {
      leases.push(await acquireSessionFileLease(target, "mutation"));
    }
    for (const lease of leases) {
      const content = readFileSync(lease.target.sessionFile, "utf8");
      const lines = content.split("\n");
      const lockedHeader = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
      if (
        lockedHeader.type === "session"
        && lockedHeader.parentSession
        && sessionPathKey(lockedHeader.parentSession) === targetPathKey
      ) {
        lockedHeader.parentSession = parentSessionPath;
        lines[0] = JSON.stringify(lockedHeader);
        writeFileSync(lease.target.sessionFile, lines.join("\n"));
      }
    }
  } finally {
    await Promise.all(leases.map((lease) => lease.release().catch(() => undefined)));
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const context = buildSessionContext(entries as never, leafId, { deferThinking, deferToolResultImages });
    const totalActiveMs = computeSessionTotalActiveMs(entries);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      orchestration: header.orchestration,
      peer: header.peer,
      transient: !filePath || !existsSync(filePath),
    } : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      totalActiveMs,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const mutationTarget = await verifySessionTarget({ sessionId: id, sessionFile: filePath });
    try {
      await assertGenericSessionMutationAllowed(mutationTarget, "changed");
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 403 });
    }
    const live = getRpcSession(id);
    if (live?.isAlive()) {
      if (live.isRestrictedModelControlledSession()) {
        return NextResponse.json(
          { error: "Peer Sessions and orchestrated workers can only be changed through their owning controller authority" },
          { status: 403 },
        );
      }
      await live.send({ type: "set_session_name", name: name.trim() });
      return NextResponse.json({ ok: true });
    }
    const lease = await acquireSessionFileLease(mutationTarget, "mutation");
    try {
      const manager = SessionManager.open(lease.target.sessionFile, lease.target.sessionDir);
      await assertGenericSessionMutationAllowed(lease.target, "changed");
      manager.appendSessionInfo(name.trim());
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    } finally {
      await lease.release().catch(() => undefined);
    }
  } catch (error) {
    const message = String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("active in another process") ? 409 : 500 },
    );
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let filePath: string;
  try {
    const resolvedPath = await resolveSessionPath(id);
    if (!resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    filePath = resolvedPath;
    const preflight = await verifySessionTarget({ sessionId: id, sessionFile: filePath });
    try {
      await assertGenericSessionMutationAllowed(preflight, "deleted");
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 403 });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
  const deletion = reserveRpcSessionDeletion(id);
  if (!deletion) {
    return NextResponse.json(
      { error: "Cannot delete a running, starting, or already deleting session" },
      { status: 409 },
    );
  }
  let deletionLease: OrchestratedSessionDeletionLease | SessionFileLease | undefined;
  try {
    const manager = SessionManager.open(filePath);
    return await withSessionOrchestrationOwnerLock(
      {
        sessionId: manager.getSessionId(),
        sessionFile: filePath,
        sessionDir: manager.getSessionDir(),
        cwd: manager.getCwd(),
        projectTrusted: true,
      },
      async () => {
        const ownedWorkers = await listOwnedOrchestratedSessions({
          sessionId: manager.getSessionId(),
          sessionFile: filePath,
          sessionDir: manager.getSessionDir(),
          cwd: manager.getCwd(),
          projectTrusted: true,
        });
        if (ownedWorkers.length > 0) {
          return NextResponse.json(
            { error: "Delete this controller's owned worker Sessions first" },
            { status: 409 },
          );
        }

        await getRpcSession(id)?.shutdown();
        await deletion.session?.destroyAndWait();
        const initialHeader = manager.getHeader();
        try {
          if (initialHeader?.orchestration !== undefined) {
            if (!isSessionOrchestrationMetadata(initialHeader.orchestration)) {
              return NextResponse.json({ error: "Orchestrated worker metadata is invalid" }, { status: 400 });
            }
            deletionLease = await acquireOrchestratedSessionDeletionLease(manager);
          } else {
            const target = await verifySessionTarget({
              sessionId: id,
              sessionFile: filePath,
              sessionDir: manager.getSessionDir(),
              cwd: manager.getCwd(),
              rejectOrchestration: true,
            });
            deletionLease = await acquireSessionFileLease(target, "deletion");
          }
        } catch (error) {
          if (String(error).includes("active in another process")) {
            return NextResponse.json(
              { error: "Cannot delete a Session active in another process" },
              { status: 409 },
            );
          }
          throw error;
        }
        const lockedFile = "target" in deletionLease
          ? deletionLease.target.sessionFile
          : deletionLease.sessionFile;
        const lockedManager = SessionManager.open(lockedFile, manager.getSessionDir());
        if (lockedManager.getSessionId() !== id || lockedManager.getCwd() !== manager.getCwd()) {
          throw new Error("Session identity changed after acquiring the deletion lease");
        }
        const header = lockedManager.getHeader();
        try {
          if ("target" in deletionLease) {
            await assertGenericSessionMutationAllowed(deletionLease.target, "deleted");
          }
        } catch (error) {
          return NextResponse.json({ error: String(error) }, { status: 409 });
        }
        await new ScheduleStore(getAgentDir()).pauseForSession(
          id,
          lockedFile,
          "Target Session was deleted",
        );
        await reparentDirectChildren(lockedFile, header?.parentSession);
        unlinkSync(lockedFile);
        invalidateSessionPathCache(id);
        invalidateSessionListCache();
        return NextResponse.json({ ok: true });
      },
    );
  } catch (error) {
    const message = String(error);
    return NextResponse.json(
      { error: message },
      { status: message.includes("active in another process") ? 409 : 500 },
    );
  } finally {
    if (deletionLease) {
      try {
        await deletionLease.release();
      } catch {
        // The Session file already has a definitive deletion outcome.
      }
    }
    deletion.release();
  }
}
