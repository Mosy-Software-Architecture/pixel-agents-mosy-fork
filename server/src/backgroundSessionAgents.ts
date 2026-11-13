/**
 * Agents whose session runs in the CLI's background service (Claude Code's
 * `claude --bg`): which ones (the cards that offer to stop the session) and
 * stopping one (`claude stop <short id>`). Only a session the CLI lists as
 * background is ever stopped: a process in another terminal is not the
 * office's to end.
 */

import type { AgentBackgroundSessions } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { BACKGROUND_SESSION_AGENTS_CHECK_MS } from './constants.js';
import { backgroundIdOf } from './conversations.js';
import type { TerminalSessions } from './terminal/terminalSessions.js';

/**
 * Each main agent whose session the CLI lists in its background service
 * (HookProvider.liveSessions, from its last answer), by agent id (as a
 * string, the wire's map key): its session's short id. Sub-agents and
 * Teammates have no card, so none of them.
 */
export function backgroundSessionAgents(
  store: AgentStateStore,
  provider: HookProvider,
): Record<string, string> {
  const bySession = new Map<string, string>();
  for (const session of provider.liveSessions?.() ?? []) {
    if (session.kind === 'background' && session.backgroundId) {
      bySession.set(session.sessionId, session.backgroundId);
    }
  }
  const agents: Record<string, string> = {};
  if (bySession.size === 0) return agents;
  for (const [id, agent] of store) {
    if (agent.spawnToolUseId || agent.leadAgentId !== undefined) continue;
    const backgroundId = bySession.get(agent.sessionId);
    if (backgroundId) agents[String(id)] = backgroundId;
  }
  return agents;
}

export function agentBackgroundSessionsMessage(
  store: AgentStateStore,
  provider: HookProvider,
): AgentBackgroundSessions {
  return { type: 'agentBackgroundSessions', agents: backgroundSessionAgents(store, provider) };
}

/**
 * Broadcast agentBackgroundSessions whenever it changes: checked when an
 * agent comes or goes (after asking the CLI anew: a new agent's session may
 * not be in the last answer) and every BACKGROUND_SESSION_AGENTS_CHECK_MS
 * while the office has agents (a read of the cached list, which asks the CLI
 * again once it is old). Returns the stop.
 */
export function watchBackgroundSessionAgents(
  store: AgentStateStore,
  provider: HookProvider,
  intervalMs: number = BACKGROUND_SESSION_AGENTS_CHECK_MS,
): () => void {
  let last = JSON.stringify(backgroundSessionAgents(store, provider));
  const check = () => {
    const message = agentBackgroundSessionsMessage(store, provider);
    const now = JSON.stringify(message.agents);
    if (now === last) return;
    last = now;
    store.broadcast({ ...message });
  };
  const onChange = () => {
    check();
    void provider.refreshLiveSessions?.().then(check);
  };
  store.on('agentAdded', onChange);
  store.on('agentRemoved', onChange);
  const timer = setInterval(() => {
    if (store.size > 0) check();
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    store.off('agentAdded', onChange);
    store.off('agentRemoved', onChange);
  };
}

export interface StopBackgroundAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: TerminalSessions;
  provider: HookProvider;
}

/**
 * Stop agent `id`'s background session (the card's skull) and close the agent
 * as a final × would: the office's terminal on it (an attach client) goes,
 * and so do the agent, its Teammates and Sub-agents. The CLI is asked anew
 * first, and only a session it lists in its background service is stopped.
 * Resolves null when stopped (or the agent was gone already), else the reason
 * it was not, with the agent left as it was.
 */
export async function stopBackgroundAgent(
  deps: StopBackgroundAgentDeps,
  id: number,
): Promise<string | null> {
  const { store, runtime, ptyManager, provider } = deps;
  const agent = store.get(id);
  if (!agent) return null;
  if (!provider.stopBackgroundSession) return 'This office cannot stop sessions';
  await provider.refreshLiveSessions?.();
  const backgroundId = backgroundIdOf(provider, agent.sessionId);
  if (!backgroundId) {
    console.warn(
      `[Pixel Agents] Background: Agent ${id} - not stopped: its session does not run in the background`,
    );
    return 'Its session does not run in the background';
  }
  try {
    await provider.stopBackgroundSession(backgroundId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Pixel Agents] Background: claude stop ${backgroundId} failed: ${reason}`);
    return reason || 'claude stop failed';
  }
  console.log(
    `[Pixel Agents] Background: Agent ${id} - stopped background session ${backgroundId}`,
  );
  // The next conversation list must not still say "Background".
  await provider.refreshLiveSessions?.();
  // Its terminal may have exited with the session and closed it already.
  if (store.get(id) !== agent) return null;
  ptyManager.dispose(id);
  runtime.unregisterAgent(agent.sessionId);
  runtime.closeAgent(id);
  return null;
}
