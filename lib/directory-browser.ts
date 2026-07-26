import { opendir, realpath, stat } from "fs/promises";
import path from "path";
import { getRuntimeHomeDirectory } from "@/lib/runtime-paths";

export interface BrowsableDirectory {
  name: string;
  path: string;
}

export function getBrowseStartDirectory(directory?: string): string {
  return directory || getRuntimeHomeDirectory();
}

export function normalizeDirectory(directory: string): string {
  if (directory === "~") return getRuntimeHomeDirectory();
  if (directory.startsWith("~/")) return path.resolve(getRuntimeHomeDirectory(), directory.slice(2));
  return path.resolve(directory);
}

export function getParentDirectory(directory: string): string | null {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith("\\\\")
    ? path.win32
    : directory.startsWith("/") ? path.posix : path;
  const normalized = pathApi.normalize(directory);
  const parent = pathApi.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function resolveDirectory(directory: string): Promise<string> {
  return realpath(normalizeDirectory(directory));
}

export async function listDirectories(directory: string): Promise<BrowsableDirectory[]> {
  // Avoid readdir here: Next.js file tracing interprets a browsable runtime
  // directory as a build input and can otherwise traverse the user's home.
  const entries = [];
  const directoryHandle = await opendir(directory);
  try {
    let entry = await directoryHandle.read();
    while (entry) {
      entries.push(entry);
      entry = await directoryHandle.read();
    }
  } finally {
    await directoryHandle.close();
  }

  // 忽略损坏、不可访问或不指向目录的符号链接。
  const candidates = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) {
      return { name: entry.name, path: path.join(directory, entry.name) };
    }
    if (!entry.isSymbolicLink()) return null;

    try {
      const entryPath = path.join(directory, entry.name);
      const realEntryPath = await realpath(entryPath);
      const entryStat = await stat(realEntryPath);
      if (!entryStat.isDirectory()) return null;
      return { name: entry.name, path: entryPath };
    } catch {
      return null;
    }
  }));

  return candidates
    .filter((entry): entry is BrowsableDirectory => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
