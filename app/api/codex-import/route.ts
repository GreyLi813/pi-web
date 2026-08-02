import { NextResponse } from "next/server";
import {
  assertCodexImportApiRequest,
  codexImportErrorResponse,
  parseCodexCandidateFilters,
  parseCodexRunRequest,
} from "@/lib/codex-import/http";
import { createRuntimeCodexImportService } from "@/lib/codex-import/service";

export const dynamic = "force-dynamic";

/**
 * Enumerate metadata-only Codex import candidates with explicit filters.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function GET(request: Request) {
  try {
    assertCodexImportApiRequest(request, false);
    const sessions = await createRuntimeCodexImportService().list(parseCodexCandidateFilters(request));
    return NextResponse.json({ sessions, total: sessions.length });
  } catch (error) {
    return codexImportErrorResponse(error);
  }
}

/**
 * Publish exactly one session covered by a signed preflight decision.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function POST(request: Request) {
  try {
    assertCodexImportApiRequest(request, true);
    const body = await parseCodexRunRequest(request);
    const result = await createRuntimeCodexImportService().import(body.preflightToken, request.signal);
    return NextResponse.json(result, { status: result.status === "imported" ? 201 : 200 });
  } catch (error) {
    return codexImportErrorResponse(error);
  }
}
