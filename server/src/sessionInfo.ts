import type { HookProvider, SessionInfo } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * An agent's session name, colour and agent setting: what the label over its
 * character shows besides its activity. The CLI records them in the
 * transcript (the provider reads them), so they reach every agent with one,
 * adopted and headless ones included.
 *
 * Seeded from the transcript when watching starts (an agent adopted or
 * resumed mid-session is read from its end, so streaming alone would leave it
 * nameless), then kept current record by record.
 */

/** The `agentSessionInfo` message for an agent; `host`: the remote host its
 *  session runs on (AgentState.remoteHost) and `remoteKind` whether it is a
 *  service there, both absent for a local one. */
export function sessionInfoMessage(
  id: number,
  info: SessionInfo,
  remote: Pick<AgentState, 'remoteHost' | 'remoteService'> = {},
): Record<string, unknown> {
  return {
    type: 'agentSessionInfo',
    id,
    title: info.title,
    color: info.color,
    agentSetting: info.agentSetting,
    host: remote.remoteHost,
    remoteKind: remote.remoteHost ? (remote.remoteService ? 'service' : 'work') : undefined,
  };
}

/** Whether two readings would show the same (the office sees no difference
 *  in `titleIsUsers`, it only decides what a later title may replace). */
function sameInfo(a: SessionInfo | undefined, b: SessionInfo): boolean {
  return (
    (a?.title ?? undefined) === b.title &&
    (a?.color ?? undefined) === b.color &&
    (a?.agentSetting ?? undefined) === b.agentSetting
  );
}

function setSessionInfo(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  info: SessionInfo,
): void {
  const changed = !sameInfo(agent.sessionInfo, info);
  agent.sessionInfo = info;
  if (changed) agents.broadcast(sessionInfoMessage(agentId, info, agent));
}

/**
 * Read the agent's session info off its transcript, replacing what it had
 * (watching starts on a new file after /clear too). An agent with nothing to
 * show tells the office only when it had something before.
 */
export function seedSessionInfo(
  agentId: number,
  agents: AgentStateStore,
  provider?: HookProvider | null,
): void {
  const agent = agents.get(agentId);
  if (!agent?.jsonlFile || !provider?.sessionInfo) return;
  setSessionInfo(agentId, agent, agents, provider.sessionInfo(agent.jsonlFile));
}

/** Fold one freshly read transcript record into the agent's session info. */
export function updateSessionInfo(
  agentId: number,
  agent: AgentState,
  agents: AgentStateStore,
  record: unknown,
  provider?: HookProvider | null,
): void {
  const news = provider?.sessionInfoFromRecord?.(record);
  if (!news) return;
  const info: SessionInfo = { ...agent.sessionInfo };
  switch (news.kind) {
    case 'title':
      // A generated title never replaces the user's own name.
      if (!news.byUser && info.titleIsUsers) return;
      info.title = news.title;
      if (news.byUser) info.titleIsUsers = true;
      break;
    case 'color':
      info.color = news.color;
      break;
    case 'agentSetting':
      info.agentSetting = news.agentSetting;
      break;
  }
  setSessionInfo(agentId, agent, agents, info);
}
