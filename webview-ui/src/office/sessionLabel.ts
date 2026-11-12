/**
 * Agents' session names and colours (agentSessionInfo), for the label over
 * each character (ToolOverlay). Kept apart from the characters, like the
 * context gauges: the server re-sends them on every connect, possibly before
 * the layout has seated the agents they belong to.
 */

import { SESSION_COLORS } from '../constants.js';

export interface AgentSessionInfo {
  /** The session's name (the user's rename, else the CLI's title). */
  title?: string;
  /** The colour the user marked it with, as the CLI names it. */
  color?: string;
  /** The agent definition it runs as. Kept for later; nothing shows it yet. */
  agentSetting?: string;
}

const infoById = new Map<number, AgentSessionInfo>();

/** Record an agentSessionInfo (useExtensionMessages): each message is the
 *  agent's whole state, so absent fields are cleared. */
export function setAgentSessionInfo(id: number, info: AgentSessionInfo): void {
  const next: AgentSessionInfo = {
    ...(info.title ? { title: info.title } : {}),
    ...(info.color ? { color: info.color } : {}),
    ...(info.agentSetting ? { agentSetting: info.agentSetting } : {}),
  };
  if (Object.keys(next).length === 0) infoById.delete(id);
  else infoById.set(id, next);
}

/** Forget a closed agent's (useExtensionMessages' closeAgent). */
export function clearAgentSessionInfo(id: number): void {
  infoById.delete(id);
}

/** An agent's session name and colour, if its session has any. */
export function agentSessionInfo(id: number): AgentSessionInfo | undefined {
  return infoById.get(id);
}

/** The text colour for a session colour name, or undefined for none or one
 *  the office doesn't know (the name then shows untinted). */
export function sessionColor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.toLowerCase();
  return Object.hasOwn(SESSION_COLORS, key) ? SESSION_COLORS[key] : undefined;
}
