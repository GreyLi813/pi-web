import { NextResponse } from "next/server";
import {
  assertCodexImportApiRequest,
  codexImportErrorResponse,
  parseCodexPreflightRequest,
} from "@/lib/codex-import/http";
import { createRuntimeCodexImportService } from "@/lib/codex-import/service";

export const dynamic = "force-dynamic";

/**
 * Snapshot, convert, validate, and plan one selected Codex session without publishing it.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function POST(request: Request) {
  try {
    assertCodexImportApiRequest(request, true);
    const body = await parseCodexPreflightRequest(request);
    const result = await createRuntimeCodexImportService().preflight(body);
    return NextResponse.json(result);
  } catch (error) {
    return codexImportErrorResponse(error);
  }
}
