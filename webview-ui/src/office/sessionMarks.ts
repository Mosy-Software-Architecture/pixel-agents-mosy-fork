/**
 * Done marks as the cards see them: each agent's session and whether it is
 * marked done (the server's agentSessionMarks, the whole map each time).
 * Kept outside React like backgroundSessions.ts: the cards read it with
 * useSyncExternalStore. Marking is App's `setSessionDone` (handleMarkDone).
 */

import type { AgentSessionMark } from '../../../core/src/messages.js';

const markById = new Map<number, AgentSessionMark>();
const listeners = new Set<() => void>();

/** Observe changes (React: the agent cards). Returns the unsubscribe. */
export function subscribeSessionMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The whole map, as the server sends it each time (keys are agent ids). */
export function setSessionMarks(agents: Readonly<Record<string, AgentSessionMark>>): void {
  markById.clear();
  for (const [key, mark] of Object.entries(agents)) {
    const id = Number(key);
    if (Number.isInteger(id) && typeof mark?.sessionId === 'string') markById.set(id, mark);
  }
  for (const listener of listeners) listener();
}

/** Agent `id`'s session and mark, if the server said. */
export function sessionMarkOf(id: number): AgentSessionMark | undefined {
  return markById.get(id);
}
