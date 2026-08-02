import { NextResponse } from "next/server";
import type { CodexImportPreflightRequest, CodexImportRunRequest } from "../api-types";
import { hasJsonContentType, isApiRequestAllowed } from "../request-security";
import { CodexImportError, asCodexImportError } from "./errors";
import type { CodexCandidateFilters } from "./types";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_FILTER_LENGTH = 1_024;
const ALLOWED_PREFLIGHT_KEYS = new Set([
  "threadId",
  "remapCwd",
  "reimportChanged",
  "crossProviderConfirmed",
  "crossProviderModel",
]);

/**
 * Reject untrusted or unexpectedly large Codex import requests.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertCodexImportApiRequest(request: Request, requiresJson: boolean): void {
  if (!isApiRequestAllowed(request)) {
    throw new CodexImportError("UNTRUSTED_REQUEST", "Untrusted API request");
  }
  if (requiresJson && !hasJsonContentType(request)) {
    throw new CodexImportError("JSON_CONTENT_TYPE_REQUIRED", "Content-Type must be application/json");
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new CodexImportError("REQUEST_TOO_LARGE", "Codex import request is too large");
  }
}

/**
 * Decode a request body with an enforced byte limit even when Content-Length is absent.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new CodexImportError("INVALID_JSON", "Codex import request contains invalid JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CodexImportError("REQUEST_TOO_LARGE", "Codex import request is too large");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof CodexImportError) throw error;
    throw new CodexImportError("INVALID_JSON", "Codex import request contains invalid JSON");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Narrow an unknown JSON value to a plain object.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function plainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexImportError("INVALID_REQUEST", "Codex import request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Read a bounded optional string query parameter.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function filterValue(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  if (!value) return undefined;
  if (value.length > MAX_FILTER_LENGTH) {
    throw new CodexImportError("INVALID_FILTER", `Filter ${name} is too long`);
  }
  return value;
}

/**
 * Parse metadata-only Codex list filters.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function parseCodexCandidateFilters(request: Request): CodexCandidateFilters {
  const params = new URL(request.url).searchParams;
  const requestedLimit = Number(params.get("limit") ?? 200);
  return {
    name: filterValue(params, "name"),
    workspace: filterValue(params, "workspace"),
    sandbox: filterValue(params, "sandbox"),
    cwd: filterValue(params, "cwd"),
    includeArchived: params.get("includeArchived") === "true" || params.get("includeArchived") === "1",
    includeSubagents: params.get("includeSubagents") === "true" || params.get("includeSubagents") === "1",
    includeGuardians: params.get("includeGuardians") === "true" || params.get("includeGuardians") === "1",
    limit: Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 200,
  };
}

/**
 * Parse a strict preflight body and reject filesystem-root override fields.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function parseCodexPreflightRequest(request: Request): Promise<CodexImportPreflightRequest> {
  const body = plainObject(await boundedJson(request));
  if (Object.keys(body).some((key) => !ALLOWED_PREFLIGHT_KEYS.has(key))) {
    throw new CodexImportError("INVALID_REQUEST", "Codex import request contains unsupported fields");
  }
  const threadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId || threadId.length > 200) {
    throw new CodexImportError("INVALID_REQUEST", "A valid Codex thread ID is required");
  }
  const remapCwd = typeof body.remapCwd === "string" ? body.remapCwd.trim() : undefined;
  let crossProviderModel: CodexImportPreflightRequest["crossProviderModel"];
  if (body.crossProviderModel !== undefined) {
    const model = plainObject(body.crossProviderModel);
    const provider = typeof model.provider === "string" ? model.provider.trim() : "";
    const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
    if (!provider || !modelId || Object.keys(model).some((key) => key !== "provider" && key !== "modelId")) {
      throw new CodexImportError("INVALID_REQUEST", "Cross-provider model selection is invalid");
    }
    crossProviderModel = { provider, modelId };
  }
  return {
    threadId,
    remapCwd: remapCwd || undefined,
    reimportChanged: body.reimportChanged === true,
    crossProviderConfirmed: body.crossProviderConfirmed === true,
    crossProviderModel,
  };
}

/**
 * Parse a strict run body containing only the signed preflight token.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function parseCodexRunRequest(request: Request): Promise<CodexImportRunRequest> {
  const body = plainObject(await boundedJson(request));
  if (Object.keys(body).length !== 1 || typeof body.preflightToken !== "string"
    || body.preflightToken.length < 32 || body.preflightToken.length > 16_384) {
    throw new CodexImportError("INVALID_REQUEST", "A valid Codex import preflight token is required");
  }
  return { preflightToken: body.preflightToken };
}

/**
 * Map structured import failures to stable HTTP responses without transcript data.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function codexImportErrorResponse(error: unknown): NextResponse {
  const failure = error instanceof SyntaxError
    ? new CodexImportError("INVALID_JSON", "Codex import request contains invalid JSON")
    : asCodexImportError(error);
  const status = failure.code === "CODEX_SESSION_NOT_FOUND" ? 404
    : ["IMPORT_LOCKED", "IMPORT_CANCELLED", "SOURCE_CHANGED", "PREFLIGHT_PLAN_CHANGED", "PREFLIGHT_TOKEN_EXPIRED"].includes(failure.code) ? 409
      : [
          "CROSS_PROVIDER_CONFIRMATION_REQUIRED",
          "LONG_CONTEXT_MODEL_UNAVAILABLE",
          "SOURCE_CHANGED_CONFIRMATION_REQUIRED",
          "CWD_REMAP_REQUIRED",
          "NO_VISIBLE_USER_MESSAGE",
          "NON_ROOT_SESSION_REJECTED",
        ].includes(failure.code) ? 422
        : ["CODEX_IMPORT_FAILED", "SESSION_SERIALIZE_FAILED", "ATOMIC_PUBLISH_FAILED"].includes(failure.code) ? 500
          : 400;
  const availableModels = failure.code === "CROSS_PROVIDER_CONFIRMATION_REQUIRED"
    && Array.isArray(failure.details?.availableModels)
    ? failure.details.availableModels.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const model = value as Record<string, unknown>;
        if (typeof model.provider !== "string" || typeof model.modelId !== "string"
          || model.provider.length > 200 || model.modelId.length > 500) return [];
        return [{ provider: model.provider, modelId: model.modelId }];
      }).slice(0, 100)
    : [];
  return NextResponse.json({
    error: failure.message,
    code: failure.code,
    ...(availableModels.length > 0 ? { details: { availableModels } } : {}),
  }, { status });
}
