/** Initialize runtime-specific Pi-Web instrumentation.
 *
 * Next compiles this entry for both Node and Edge. The conditional import is
 * required so Edge compilation never traverses Node-only Session modules.
 *
 * @author GPT-5.6 Sol
 * @version 3.0.0
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNodeInstrumentation } = await import("./instrumentation-node");
  await registerNodeInstrumentation();
}
