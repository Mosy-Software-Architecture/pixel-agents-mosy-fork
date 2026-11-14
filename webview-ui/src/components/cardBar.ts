/** Pure rules shared by the agent card bars — which agents get a card and in
 *  what order, highlight tier, the ×, and drag-to-reorder (DOM-free, so they
 *  run on the Node runner). */

import { sessionName } from '../office/sessionLabel.js';

/** Card highlight tiers: 'focused' = the agent's character is selected in the
 *  office (active background, no border); 'active' = its terminal pane is the
 *  one showing (background + accent border). */
export type CardVariant = 'default' | 'focused' | 'active';

/** One rule for both card bars: the showing terminal pane wins, then the
 *  character selected in the office. Pass activeId null where no pane shows
 *  (VS Code, or the mobile office page). */
export function cardVariant(
  agentId: number,
  { activeId, focusedId }: { activeId: number | null; focusedId: number | null },
): CardVariant {
  if (agentId === activeId) return 'active';
  if (agentId === focusedId) return 'focused';
  return 'default';
}

/** How a card shows its ×: always, on hover, or not at all. */
export type CloseMode = 'shown' | 'hover' | 'hidden';

/** The × rule: on hover (desktop), or with `onlyWhenActive` (phone: a stray
 *  tap must not close an agent) only on the active card. */
export function closeMode(variant: CardVariant, onlyWhenActive: boolean): CloseMode {
  if (!onlyWhenActive) return 'hover';
  return variant === 'active' ? 'shown' : 'hidden';
}

/** Where a card's stop button (the skull) stands: armed by a first press,
 *  stopping once the second one sent the stop, or failed (the server said
 *  why). Absent = at rest. */
export type StopPhase = 'armed' | 'stopping' | 'failed';

/**
 * How a card shows its skull, or null for none: only on an agent whose
 * session runs in the CLI's background service (`backgroundId`, from the
 * server's agentBackgroundSessions) and only where this office may stop it
 * (`canStop`: a tokened standalone office). An interactive session in
 * another terminal never gets one: the office must not end another
 * terminal's process. At rest it follows the × (`close`); armed, stopping or
 * failed it stays shown, so the state does not vanish with the pointer.
 */
export function stopMode(
  close: CloseMode,
  {
    backgroundId,
    canStop,
    phase,
  }: { backgroundId: string | undefined; canStop: boolean; phase: StopPhase | undefined },
): CloseMode | null {
  if (!canStop || !backgroundId) return null;
  return phase ? 'shown' : close;
}

/**
 * How a card shows its done check (office/sessionMarks.ts), or null for none:
 * a button that marks or unmarks the session where this office may
 * (`canMark`: a tokened standalone office; never a remote session, whose mark
 * is its host's), else `badge`, a check that only shows. Not done, the button
 * follows the × (`close`). Done, the desktop label already carries a check
 * before the name (`showLabel`), so the button still follows the ×; the
 * phone row has no label, so the button (or the badge) stays shown.
 */
export function markMode(
  close: CloseMode,
  {
    mark,
    canMark,
    showLabel,
  }: {
    mark: { done?: boolean; remote?: boolean } | undefined;
    canMark: boolean;
    showLabel: boolean;
  },
): CloseMode | 'badge' | null {
  if (!mark) return null;
  const done = mark.done === true;
  if (!canMark || mark.remote) return done && !showLabel ? 'badge' : null;
  return done && !showLabel ? 'shown' : close;
}

/** The done check's tooltip (and accessible name), on a card or a row. */
export function markTitle(done: boolean): string {
  return done ? 'Done: press to take the mark off' : 'Mark as done';
}

/** A press on the skull: the first arms it, the second (while armed) sends
 *  the stop, and one while stopping does nothing. A failed one arms again. */
export function stopPress(phase: StopPhase | undefined): { phase: StopPhase; send: boolean } {
  if (phase === 'armed') return { phase: 'stopping', send: true };
  if (phase === 'stopping') return { phase: 'stopping', send: false };
  return { phase: 'armed', send: false };
}

/** The skull's tooltip (and accessible name) for its phase. */
export function stopTitle(
  phase: StopPhase | undefined,
  backgroundId: string,
  reason?: string,
): string {
  switch (phase) {
    case 'armed':
      return `Press again to stop this session (claude stop ${backgroundId})`;
    case 'stopping':
      return 'Stopping the session…';
    case 'failed':
      return `Could not stop the session: ${reason ?? 'unknown error'}`;
    default:
      return 'Stop session (it runs in the background)';
  }
}

/** The cards, in order: main agents only (a Teammate is shown by its
 *  character beside its Lead, never as a card of its own), in the saved
 *  order with new ones appended (mergeOrder). */
export function cardOrderOf(
  saved: readonly number[],
  agents: readonly number[],
  teammateIds: ReadonlySet<number>,
): number[] {
  return mergeOrder(
    saved,
    agents.filter((id) => !teammateIds.has(id)),
  );
}

/** Saved order first (dropping closed agents), then any new agents appended
 *  in creation order — so a reorder survives launches and closes. */
export function mergeOrder(saved: readonly number[], live: readonly number[]): number[] {
  const liveSet = new Set(live);
  const ordered = saved.filter((id) => liveSet.has(id));
  const seen = new Set(ordered);
  for (const id of live) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * The order with `dragId` moved to where the pointer is: before the first
 * other card whose midpoint along the bar's axis lies past `x` (the pointer's
 * coordinate on that axis), else last.
 * `midpointOf` returns a card's midpoint in the same coordinate space as `x`
 * (null for a card that isn't laid out, which is skipped).
 */
export function reorderByPointer(
  ids: readonly number[],
  dragId: number,
  midpointOf: (id: number) => number | null,
  x: number,
): number[] {
  const others = ids.filter((id) => id !== dragId);
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const mid = midpointOf(others[i]);
    if (mid !== null && x < mid) {
      insertAt = i;
      break;
    }
  }
  return [...others.slice(0, insertAt), dragId, ...others.slice(insertAt)];
}

/**
 * A card's tooltip, one line each: the name of the character its agent wears
 * (the roster's name for it), then the session's name. Either may be unknown:
 * an external char_N.png character has no name, and a session gets one only
 * once the user renames it or the CLI titles it. `Agent <id>` stands in for
 * the session's name, so a card always says something. A remote host's
 * session says where it runs, last (and that it is a service there).
 */
export function cardTitleLines({
  agentId,
  characterName,
  sessionTitle,
  host,
  service,
}: {
  agentId: number;
  characterName?: string;
  sessionTitle?: string;
  host?: string;
  service?: boolean;
}): string[] {
  const lines: string[] = [];
  if (characterName) lines.push(characterName);
  lines.push(sessionName(agentId, sessionTitle));
  if (host) lines.push(service ? `service on ${host}` : `on ${host}`);
  return lines;
}
