import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { CodexImportError } from "./errors";

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;

/**
 * Normalize a path for stable local comparisons.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function normalizePathForComparison(value: string): string {
  const windowsPath = WINDOWS_ABSOLUTE_RE.test(value) || value.startsWith("\\\\") || value.startsWith("//");
  const resolver = windowsPath ? win32 : { resolve };
  const normalized = resolver.resolve(value).replace(/[\\/]+$/, "");
  return (process.platform === "win32" || windowsPath) ? normalized.toLowerCase() : normalized;
}

/**
 * Return whether candidate is equal to or contained by root.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function isPathWithin(candidate: string, root: string): boolean {
  const windowsPath = WINDOWS_ABSOLUTE_RE.test(candidate) || WINDOWS_ABSOLUTE_RE.test(root);
  const pathApi = windowsPath ? win32 : { resolve, relative, isAbsolute };
  const relation = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !pathApi.isAbsolute(relation));
}

/**
 * Reject symbolic links and Windows Junctions in every existing component.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertNoLinkedPathComponents(candidate: string): void {
  const absolute = resolve(candidate);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new CodexImportError("LINKED_PATH_REJECTED", "Symbolic links and Junctions are not allowed in import paths");
    }
  }
}

/**
 * Resolve an existing path and prove its real path remains under a root.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function assertExistingPathWithin(candidate: string, root: string, code = "PATH_REJECTED"): string {
  assertNoLinkedPathComponents(root);
  assertNoLinkedPathComponents(candidate);
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = realpathSync.native(root);
    realCandidate = realpathSync.native(candidate);
  } catch {
    throw new CodexImportError(code, "Import path does not exist");
  }
  if (!isPathWithin(realCandidate, realRoot)) {
    throw new CodexImportError(code, "Import path resolves outside its allowed root");
  }
  return realCandidate;
}

/**
 * Create a directory one component at a time and recheck its real location.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function ensureSecureDirectory(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isPathWithin(absoluteCandidate, absoluteRoot)) {
    throw new CodexImportError("PATH_TRAVERSAL_REJECTED", "Import directory escapes its fixed root");
  }
  assertNoLinkedPathComponents(absoluteRoot);
  mkdirSync(absoluteRoot, { recursive: true });
  assertNoLinkedPathComponents(absoluteRoot);
  const relation = relative(absoluteRoot, absoluteCandidate);
  let current = absoluteRoot;
  for (const part of relation.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink() || !statSync(current).isDirectory()) {
        throw new CodexImportError("LINKED_PATH_REJECTED", "Import directory contains a link or non-directory component");
      }
    } else {
      mkdirSync(current);
    }
    assertNoLinkedPathComponents(current);
  }
  const realRoot = realpathSync.native(absoluteRoot);
  const realCandidate = realpathSync.native(absoluteCandidate);
  if (!isPathWithin(realCandidate, realRoot)) {
    throw new CodexImportError("REALPATH_ESCAPE_REJECTED", "Import directory resolves outside its fixed root");
  }
  return realCandidate;
}

/**
 * Open an existing regular file without following a final symbolic link.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export function openRegularFileNoFollow(filePath: string): { fd: number; stats: Stats } {
  assertNoLinkedPathComponents(filePath);
  const before = lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new CodexImportError("SOURCE_FILE_REJECTED", "Codex rollout must be a regular unlinked file");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new CodexImportError("SOURCE_OPEN_FAILED", "Unable to open the Codex rollout safely", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(fd);
    throw new CodexImportError("SOURCE_CHANGED", "File identity changed while it was opened");
  }
  return { fd, stats: before };
}
