import { NextResponse } from "next/server";
import { assertCodexImportApiRequest, codexImportErrorResponse } from "@/lib/codex-import/http";
import { createRuntimeCodexImportService } from "@/lib/codex-import/service";
import { CodexImportError } from "@/lib/codex-import/errors";

export const dynamic = "force-dynamic";

/**
 * Return metadata-only details for one SQLite-authorized Codex thread.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertCodexImportApiRequest(request, false);
    const { id } = await params;
    if (!id || id.length > 200) {
      throw new CodexImportError("INVALID_REQUEST", "A valid Codex thread ID is required");
    }
    return NextResponse.json({ session: await createRuntimeCodexImportService().detail(id) });
  } catch (error) {
    return codexImportErrorResponse(error);
  }
}
