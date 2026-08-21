export interface ExactRunIdentity {
  runId: string | null;
  runEpoch: number;
}

interface CancelRunWithRecheckOptions {
  requestedRunId: string;
  identity: ExactRunIdentity;
  getState(): Promise<ExactRunIdentity>;
  cancel(identity: { runId: string; runEpoch: number }): Promise<{ cancelled?: boolean } | undefined>;
}

/** Cancel only the requested run, re-reading state once when admission races cancellation.
 *
 * A false cancellation never falls back to an unrelated active run. The caller
 * keeps its pending intent and invokes this helper again when POST/SSE reveals
 * the requested identity.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function cancelRunWithRecheck({
  requestedRunId,
  identity,
  getState,
  cancel,
}: CancelRunWithRecheckOptions): Promise<boolean> {
  if (
    identity.runId !== requestedRunId
    || !Number.isSafeInteger(identity.runEpoch)
    || identity.runEpoch < 0
  ) return false;
  const first = await cancel({ runId: requestedRunId, runEpoch: identity.runEpoch });
  if (first?.cancelled === true) return true;

  const current = await getState();
  if (
    current.runId !== requestedRunId
    || !Number.isSafeInteger(current.runEpoch)
    || current.runEpoch < 0
  ) return false;
  const second = await cancel({ runId: requestedRunId, runEpoch: current.runEpoch });
  return second?.cancelled === true;
}
