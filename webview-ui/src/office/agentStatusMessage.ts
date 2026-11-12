/**
 * What an `agentStatus` message does to its character (useExtensionMessages).
 * Pure over the office state, so it runs on the Node test runner.
 */

import type { OfficeState } from './engine/officeState.js';
import { statusRings } from './pendingAck.js';

/** The fields of an `agentStatus` message this reads. */
export interface AgentStatusMessage {
  id: number;
  status: string;
  awaitingInput?: unknown;
  pausedForSpawns?: unknown;
  silent?: unknown;
}

/**
 * Apply an `agentStatus` to its character. Returns whether it rings: a turn
 * that ended for the user stands the agent up and shows the check (or the
 * question), and the caller plays the done chime. A lead paused on its
 * background agents, or a state update (a connect's replay, a late idle
 * report), rests where it is: no turn-end animation, no chime. A question
 * replayed keeps its mark.
 */
export function applyAgentStatus(os: OfficeState, msg: AgentStatusMessage): boolean {
  const { id, status } = msg;
  const paused = typeof msg.pausedForSpawns === 'number' ? msg.pausedForSpawns : undefined;
  const ch = os.characters.get(id);
  if (ch) ch.pausedForSpawns = status === 'waiting' ? paused : undefined;
  if (status === 'active') {
    os.setAgentActive(id, true);
    return false;
  }
  if (statusRings(msg)) {
    os.setAgentActive(id, false);
    os.showWaitingBubble(id, msg.awaitingInput === true);
    return true;
  }
  os.restAgent(id);
  if (msg.awaitingInput === true) os.showWaitingBubble(id, true);
  return false;
}
