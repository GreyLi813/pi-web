import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import { CodexImportError } from "./errors";
import { openRegularFileNoFollow } from "./filesystem";

export type CodexJsonlRecord = Record<string, unknown>;

const MAX_JSONL_LINE_CHARS = 256 * 1024 * 1024;

/**
 * Parse one non-empty JSONL record without exposing its contents in failures.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function parseJsonlRecord(line: string, lineNumber: number): CodexJsonlRecord {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (normalized.length === 0) {
    throw new CodexImportError("MALFORMED_JSONL", "Codex JSONL contains an empty record", { lineNumber });
  }

  let value: unknown;
  try {
    value = JSON.parse(normalized);
  } catch {
    throw new CodexImportError("MALFORMED_JSONL", "Codex JSONL contains malformed JSON", { lineNumber });
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new CodexImportError("MALFORMED_JSONL", "Codex JSONL records must be JSON objects", { lineNumber });
  }
  return value as CodexJsonlRecord;
}

/**
 * Read every Codex JSONL record, including an unterminated final record, and fail closed on corruption.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function* readStrictCodexJsonl(
  filePath: string,
  expected?: { hash: string; size: number },
): AsyncGenerator<CodexJsonlRecord> {
  const { fd } = openRegularFileNoFollow(filePath);
  const before = fstatSync(fd);
  if (expected && before.size !== expected.size) {
    closeSync(fd);
    throw new CodexImportError("SNAPSHOT_CHANGED", "Codex JSONL length changed before parsing");
  }
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  let lineNumber = 0;
  let offset = 0;

  try {
    while (offset < before.size) {
      const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new CodexImportError("SNAPSHOT_CHANGED", "Codex JSONL was truncated while parsing");
      const chunk = buffer.subarray(0, bytesRead);
      offset += bytesRead;
      hash.update(chunk);
      try {
        pending += decoder.decode(chunk, { stream: true });
      } catch {
        throw new CodexImportError("MALFORMED_JSONL", "Codex JSONL is not valid UTF-8", {
          lineNumber: lineNumber + 1,
        });
      }

      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lineNumber += 1;
        yield parseJsonlRecord(pending.slice(0, newline), lineNumber);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_JSONL_LINE_CHARS) {
        throw new CodexImportError("JSONL_LINE_TOO_LARGE", "A Codex JSONL record exceeds the safe import limit");
      }
    }

    try {
      pending += decoder.decode();
    } catch {
      throw new CodexImportError("MALFORMED_JSONL", "Codex JSONL is not valid UTF-8", {
        lineNumber: lineNumber + 1,
      });
    }
    if (pending.length > 0) {
      lineNumber += 1;
      yield parseJsonlRecord(pending, lineNumber);
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(filePath);
    const changed = before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino
      || pathAfter.size !== after.size || pathAfter.mtimeMs !== after.mtimeMs;
    if (changed || (expected && hash.digest("hex") !== expected.hash)) {
      throw new CodexImportError("SNAPSHOT_CHANGED", "Codex JSONL changed while it was parsed");
    }
  } catch (error) {
    if (error instanceof CodexImportError) throw error;
    throw new CodexImportError("CODEX_JSONL_READ_FAILED", "Unable to read Codex JSONL safely", {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    closeSync(fd);
  }
}
