/**
 * Which agents' sessions run in the CLI's background service (the server's
 * agentBackgroundSessions: agent id → the session's short id) and where each
 * card's stop button stands (cardBar.ts `StopPhase`). Kept outside React like
 * pendingAck.ts: the cards read it with useSyncExternalStore.
 */

import type { StopPhase } from '../components/cardBar.js';
import { stopPress } from '../components/cardBar.js';
import {
  STOP_SESSION_ARM_MS,
  STOP_SESSION_FAILED_SHOW_MS,
  STOP_SESSION_STOPPING_MAX_MS,
} from '../constants.js';

/** A card's stop button that is not at rest; `reason` when it failed. */
export interface StopState {
  phase: StopPhase;
  reason?: string;
}

const backgroundById = new Map<number, string>();
const stopById = new Map<number, StopState>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Observe changes (React: the agent cards). Returns the unsubscribe. */
export function subscribeBackgroundSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The whole map, as the server sends it each time (keys are agent ids). */
export function setBackgroundSessions(agents: Readonly<Record<string, string>>): void {
  backgroundById.clear();
  for (const [key, backgroundId] of Object.entries(agents)) {
    const id = Number(key);
    if (Number.isInteger(id) && typeof backgroundId === 'string' && backgroundId) {
      backgroundById.set(id, backgroundId);
    }
  }
  changed();
}

/** The short id of the background session agent `id` runs, if any. */
export function backgroundSessionOf(id: number): string | undefined {
  return backgroundById.get(id);
}

/** Where agent `id`'s stop button stands; undefined at rest. */
export function stopStateOf(id: number): StopState | undefined {
  return stopById.get(id);
}

function setStop(id: number, state: StopState | undefined, clearAfterMs?: number): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (state) stopById.set(id, state);
  else stopById.delete(id);
  if (state && clearAfterMs !== undefined) {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        if (stopById.get(id) === state) {
          stopById.delete(id);
          changed();
        }
      }, clearAfterMs),
    );
  }
  changed();
}

/** A press on agent `id`'s skull (stopPress): arms it, or with it armed asks
 *  `send` to stop the session. */
export function pressStop(id: number, send: (id: number) => void): void {
  const next = stopPress(stopById.get(id)?.phase);
  if (next.phase === 'armed') setStop(id, { phase: 'armed' }, STOP_SESSION_ARM_MS);
  else if (next.send) {
    // The agent's agentClosed ends it; a reply that never comes must not
    // leave the skull stuck.
    setStop(id, { phase: 'stopping' }, STOP_SESSION_STOPPING_MAX_MS);
    send(id);
  }
}

/** The server could not stop it (agentSessionStopFailed): show why for a while. */
export function stopFailed(id: number, reason: string): void {
  setStop(id, { phase: 'failed', reason }, STOP_SESSION_FAILED_SHOW_MS);
}

/** The agent left the office: forget its button. */
export function clearStop(id: number): void {
  if (!stopById.has(id) && !timers.has(id)) return;
  setStop(id, undefined);
}
