import { homedir, tmpdir } from "os";

/**
 * Resolve user-specific directories at runtime.
 *
 * Keeping these calls behind an application function prevents Next.js file
 * tracing from treating the build machine's home and temp directories as
 * static application assets.
 */
export function getRuntimeHomeDirectory(): string {
  return homedir();
}

export function getRuntimeTempDirectory(): string {
  return tmpdir();
}
