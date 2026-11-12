import type { AgentLook } from '../../core/src/messages.js';
import { rosterPick } from '../../core/src/paletteUtils.js';
import type { AgentStateStore } from './agentStateStore.js';
import { characterProfilesLoadedMessage } from './characterProfilesPersistence.js';
import { recordConversationLooks } from './conversations.js';
import { assignPaletteIfNeeded, getPaletteCount } from './paletteAssigner.js';
import { recordCharacterUse } from './recentCharacters.js';
import type { AgentState } from './types.js';

/**
 * Dressing a running agent in another character (`setAgentCharacter`, the roster's Wear
 * button with that agent selected), shared by both hosts.
 *
 * The agent wears the character the way a launch picked from the roster would (core
 * chooseLook through assignPaletteIfNeeded: worn even when someone else wears it, as its
 * next repeat). Its followers (teammates, background spawns) copy its new look, as they
 * copied the old one. The look is persisted where a look lives: the agent itself (a
 * reload or restore keeps it), its saved seat, and its session's remembered look (a
 * resumed conversation comes back wearing it).
 */

/**
 * Dress agent `id` in character `palette` (both unvalidated, off the wire). Returns the
 * looks that changed (the agent first, then its followers), or null when nothing did: an
 * unknown agent, one that copies its Lead's look, a palette outside the cast, or the
 * character it already wears.
 */
export function dressAgent(
  store: AgentStateStore,
  id: unknown,
  palette: unknown,
): AgentLook[] | null {
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const agent = store.get(id);
  // A teammate or background spawn wears its Lead's look; dress the Lead instead.
  if (!agent || agent.leadAgentId !== undefined) return null;
  const picked = rosterPick(palette, getPaletteCount());
  if (picked === undefined || picked === agent.palette) return null;

  agent.palette = undefined;
  agent.repeat = undefined;
  assignPaletteIfNeeded(agent, store, { picked });
  const changed: AgentState[] = [agent];
  for (const follower of store.values()) {
    if (follower.leadAgentId !== id) continue;
    follower.palette = agent.palette;
    follower.repeat = agent.repeat;
    changed.push(follower);
  }

  store.persist();
  const adapter = store.getAdapter();
  const seats = adapter?.loadSeats() ?? {};
  let seatsChanged = false;
  for (const dressed of changed) {
    const seat = seats[String(dressed.id)];
    if (!seat) continue;
    seat.palette = dressed.palette;
    seat.repeat = dressed.repeat;
    seatsChanged = true;
  }
  if (seatsChanged) adapter?.saveSeats(seats);
  recordConversationLooks(
    store,
    Object.fromEntries(changed.map((a) => [String(a.id), { seatId: seats[String(a.id)]?.seatId }])),
  );
  return changed.map((a) => ({ id: a.id, palette: a.palette!, repeat: a.repeat ?? 0 }));
}

/** What a host must supply to dispatch `setAgentCharacter`. */
export interface AgentCharacterMessageDeps {
  store: AgentStateStore;
  /** Fan a message out to every connected office. */
  broadcast: (message: Record<string, unknown>) => void;
}

/**
 * Handle `setAgentCharacter`, shared by both hosts: dress the agent, then tell every
 * office. The new looks ride the message the cast already sends when looks move
 * (`characterProfilesLoaded.agentLooks`, with the list unchanged, which an office takes as
 * its own echo), and the character moves to the front of the roster, like a launch
 * wearing it.
 */
export function handleAgentCharacterClientMessage(
  msg: { id?: unknown; palette?: unknown },
  deps: AgentCharacterMessageDeps,
): void {
  const looks = dressAgent(deps.store, msg.id, msg.palette);
  if (!looks) return;
  deps.broadcast(characterProfilesLoadedMessage(undefined, undefined, undefined, looks));
  const recent = recordCharacterUse(looks[0].palette);
  if (recent) deps.broadcast(recent);
}
