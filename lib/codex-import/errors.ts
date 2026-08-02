/**
 * Structured failure returned by the Codex import boundary.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export class CodexImportError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CodexImportError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Convert an unknown failure into a safe structured import failure.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function asCodexImportError(error: unknown, fallbackCode = "CODEX_IMPORT_FAILED"): CodexImportError {
  if (error instanceof CodexImportError) return error;
  return new CodexImportError(fallbackCode, "Codex session import failed safely");
}
