/**
 * Dressing the selected agent from the roster (its cards' Wear button): which
 * agent that is, and how the button names what it does. Pure, so the Node
 * runner tests it; the office and the session names are read by the caller.
 */

/** What of a character decides whether its agent can be dressed. */
interface DressableCharacter {
  id: number;
  palette: number;
  isSubagent: boolean;
  /** Set on a teammate (and a background spawn): it wears its Lead's look. */
  leadAgentId?: number;
}

/** The agent a Wear button dresses: its id, its name for the button's label,
 *  and the character it wears now (that card offers no Wear). */
export interface DressTarget {
  agentId: number;
  agentLabel: string;
  wornPalette: number;
}

/**
 * The selected character's agent, when it can be dressed: an agent of its
 * own, not a sub-agent or a teammate (they wear their Lead's look; the server
 * refuses them too). Null with nothing selected, which leaves the roster as it
 * always was. `sessionTitle` names it, else `Agent <id>` (the card's fallback).
 */
export function dressTargetOf(
  character: DressableCharacter | undefined,
  sessionTitle: string | undefined,
): DressTarget | null {
  if (!character || character.isSubagent || character.leadAgentId !== undefined) return null;
  return {
    agentId: character.id,
    agentLabel: sessionTitle || `Agent ${character.id}`,
    wornPalette: character.palette,
  };
}

/** The Wear button's accessible name. */
export function dressLabel(target: DressTarget, characterName: string): string {
  return `Dress ${target.agentLabel} as ${characterName}`;
}
