import {
  getAgentDir,
  PeerAuthorityStore,
  type VerifiedSessionTarget,
} from "@earendil-works/pi-coding-agent";

/** Return whether an exact target is governed by worker/peer owner authority.
 *
 * The host authority lookup also catches an in-place peer header removal,
 * because physical file identity remains bound in peer-authorities.json.
 *
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function isModelControlledSessionTarget(
  target: VerifiedSessionTarget,
  agentDir: string = getAgentDir(),
): Promise<boolean> {
  if (target.header.orchestration !== undefined || target.header.peer !== undefined) return true;
  const authority = await new PeerAuthorityStore(agentDir).read();
  return authority.authorities.some((entry) => (
    entry.peerTarget.sessionId === target.sessionId && entry.peerTarget.fileKey === target.fileKey
  ));
}

/** Reject a generic mutation that lacks an owning controller host capability.
 * @author GPT-5.6 Sol
 * @version 1.0.0
 */
export async function assertGenericSessionMutationAllowed(
  target: VerifiedSessionTarget,
  operation: string,
): Promise<void> {
  if (await isModelControlledSessionTarget(target)) {
    throw new Error(
      `Peer Sessions and orchestrated workers can only be ${operation} through their owning controller authority`,
    );
  }
}
