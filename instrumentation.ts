/** Initialize runtime-specific Pi-Web instrumentation.
 *
 * Next compiles this entry for both Node and Edge. The conditional import is
 * required so Edge compilation never traverses Node-only Session modules.
 *
 * @author GPT-5.6 Sol
 * @version 3.0.0
 */
export async function register(): Promise<void> {
  // Next builds this file for both the Node and the Edge instrumentation entry.
  // The Edge graph rejects Node APIs, so `process.on` and undici live in
  // ./instrumentation-node, reached only through this compile-time-eliminated
  // NEXT_RUNTIME branch. An early `return` instead of this `if` would leave the
  // Node calls in the Edge module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node");
    await registerNodeInstrumentation();
  }
}
