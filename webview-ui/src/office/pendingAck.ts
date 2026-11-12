/**
 * Agents that rang for the user and haven't been looked at yet: a turn that
 * ended (`agentStatus` waiting: Stop), a question the agent asked
 * (`awaitingInput`: AskUserQuestion, ExitPlanMode) or a permission prompt —
 * every time the chime sounds. While pending, the character keeps its bubble
 * (ToolOverlay) and the agent's card a ring (AgentCard), so after the chime
 * the office still says who rang. Cleared when the user acknowledges it
 * (clicks the character or the card, its terminal is shown, or it rang while
 * its terminal was already in front: office/autoAck.ts) or when the agent
 * moves on (a tool or a turn starts, the question is answered).
 */

/** What the agent is waiting on: the bubble kept over its character. */
export type PendingAck = 'waiting' | 'permission';

const pendingById = new Map<number, PendingAck>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Observe changes (React: the agent cards). Returns the unsubscribe. */
export function subscribePendingAck(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What an agent is waiting on the user for, if it rang and nobody looked yet. */
export function pendingAckOf(id: number): PendingAck | undefined {
  return pendingById.get(id);
}

export function setPendingAck(id: number, kind: PendingAck): void {
  if (pendingById.get(id) === kind) return;
  pendingById.set(id, kind);
  changed();
}

/** The user saw it, the agent moved on, or the agent closed. */
export function clearPendingAck(id: number): void {
  if (pendingById.delete(id)) changed();
}

/** The fields of a server message the pending state reads. */
interface AgentMessage {
  type: string;
  id?: unknown;
  status?: unknown;
  awaitingInput?: unknown;
  permissionActive?: unknown;
  runInBackground?: unknown;
}

/** A server message's effect on its agent's pending state: start one, clear
 *  it, or nothing. Sub-agent messages (subagent*) never ring for the user. */
export function pendingAckChange(msg: AgentMessage): PendingAck | 'clear' | null {
  switch (msg.type) {
    case 'agentStatus':
      if (msg.status === 'active') return 'clear';
      // A live turn end always says whether it awaits input; the status a
      // connect replays (agentActivityResend) doesn't, and rings no one.
      return msg.status === 'waiting' && typeof msg.awaitingInput === 'boolean' ? 'waiting' : null;
    case 'agentToolPermission':
      return 'permission';
    case 'agentToolStart':
      // A tool replayed still awaiting permission, or a background spawn
      // re-sent at a turn's end, is not the agent moving on.
      return msg.permissionActive || msg.runInBackground ? null : 'clear';
    case 'agentToolPermissionClear':
    case 'agentToolsClear':
      return 'clear';
    default:
      return null;
  }
}

/** Apply a server message to the pending set (useExtensionMessages). */
export function applyPendingAckMessage(msg: AgentMessage): void {
  if (typeof msg.id !== 'number') return;
  const change = pendingAckChange(msg);
  if (change === 'clear') clearPendingAck(msg.id);
  else if (change) setPendingAck(msg.id, change);
}
