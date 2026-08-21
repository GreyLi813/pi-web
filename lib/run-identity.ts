export interface ServerRunIdentity {
  runtimeInstanceId: string | null;
  epoch: number;
  runId: string | null;
  retiredInstanceIds: string[];
}

export interface RunIdentityCandidate {
  runtimeInstanceId?: unknown;
  runEpoch?: unknown;
  runId?: unknown;
}

export interface RunIdentityDecision {
  accepted: boolean;
  identity: ServerRunIdentity;
}

/** Parse one optional non-negative run epoch without accepting malformed values.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
function candidateEpoch(candidate: RunIdentityCandidate): number | undefined {
  if (candidate.runEpoch === undefined) return undefined;
  if (!Number.isSafeInteger(candidate.runEpoch) || (candidate.runEpoch as number) < 0) return Number.NaN;
  return candidate.runEpoch as number;
}

/** Decide whether one SSE/state identity can mutate current client state.
 *
 * A new server runtime instance starts a fresh epoch domain. Once replaced, an
 * instance ID is retired so buffered responses from that old EventSource cannot
 * switch the client back. Within one instance, older epochs and same-epoch IDs
 * from another run are rejected.
 *
 * @author GPT-5.6 Sol
 * @version 2.0.0
 */
export function acceptRunIdentity(
  current: ServerRunIdentity,
  candidate: RunIdentityCandidate,
): RunIdentityDecision {
  const suppliedInstance = candidate.runtimeInstanceId;
  if (suppliedInstance !== undefined && (typeof suppliedInstance !== "string" || !suppliedInstance)) {
    return { accepted: false, identity: current };
  }
  const runtimeInstanceId = typeof suppliedInstance === "string"
    ? suppliedInstance
    : current.runtimeInstanceId;
  const epoch = candidateEpoch(candidate);
  if (Number.isNaN(epoch)) return { accepted: false, identity: current };
  const runId = typeof candidate.runId === "string" && candidate.runId ? candidate.runId : null;

  if (runtimeInstanceId && runtimeInstanceId !== current.runtimeInstanceId) {
    if (current.retiredInstanceIds.includes(runtimeInstanceId)) {
      return { accepted: false, identity: current };
    }
    const retiredInstanceIds = current.runtimeInstanceId
      ? [...current.retiredInstanceIds.filter((id) => id !== current.runtimeInstanceId), current.runtimeInstanceId].slice(-8)
      : [...current.retiredInstanceIds];
    return {
      accepted: true,
      identity: {
        runtimeInstanceId,
        epoch: epoch ?? 0,
        runId: epoch === undefined ? null : runId,
        retiredInstanceIds,
      },
    };
  }

  if (epoch === undefined) return { accepted: true, identity: current };
  if (epoch < current.epoch) return { accepted: false, identity: current };
  if (epoch === current.epoch && runId && current.runId && runId !== current.runId) {
    return { accepted: false, identity: current };
  }
  if (epoch > current.epoch) {
    return {
      accepted: true,
      identity: { ...current, runtimeInstanceId, epoch, runId },
    };
  }
  return {
    accepted: true,
    identity: runId ? { ...current, runtimeInstanceId, epoch, runId } : current,
  };
}
