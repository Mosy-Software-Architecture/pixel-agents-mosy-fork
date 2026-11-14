/**
 * Done marks in the office (HookProvider.sessionMarks): which agents' sessions
 * are marked done (the card's check), and marking one from the office (the
 * card's and the search row's check button, `setSessionDone`). The sidebar's
 * side (done conversations left out of its lists) is conversations.ts.
 */

import type { AgentSessionMark, AgentSessionMarks } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { SESSION_MARKS_CHECK_MS } from './constants.js';
import { SESSION_ID_PATTERN } from './conversations.js';
import { remoteSessionDone } from './remoteHosts.js';

/** The sessions marked done whose mark holds; none when the provider keeps no
 *  marks or they can't be read. */
export function doneSessionsOf(provider: HookProvider): ReadonlyMap<string, number> {
  try {
    return provider.sessionMarks?.doneSessions() ?? new Map();
  } catch (err) {
    console.error('[Pixel Agents] Reading the done marks failed:', err);
    return new Map();
  }
}

/**
 * Each main agent's session and whether it is marked done, by agent id (as a
 * string, the wire's map key). A remote agent's mark is its host's (read with
 * the host's listing) and flagged `remote`: the office only shows it.
 * Sub-agents and Teammates have no card, so none of them.
 */
export function agentSessionMarks(
  store: AgentStateStore,
  provider: HookProvider,
): Record<string, AgentSessionMark> {
  const done = doneSessionsOf(provider);
  const agents: Record<string, AgentSessionMark> = {};
  for (const [id, agent] of store) {
    if (agent.spawnToolUseId || agent.leadAgentId !== undefined || !agent.sessionId) continue;
    const remote = agent.remoteHost;
    const marked = remote ? remoteSessionDone(remote, agent.sessionId) : done.has(agent.sessionId);
    agents[String(id)] = {
      sessionId: agent.sessionId,
      ...(marked ? { done: true } : {}),
      ...(remote ? { remote: true } : {}),
    };
  }
  return agents;
}

export function agentSessionMarksMessage(
  store: AgentStateStore,
  provider: HookProvider,
): AgentSessionMarks {
  return { type: 'agentSessionMarks', agents: agentSessionMarks(store, provider) };
}

/**
 * Broadcast agentSessionMarks: always when the marks file changed (another
 * tool marked a session, or the office did: every office then also asks for
 * its conversation lists again), and when the agents' marks changed: checked
 * when an agent comes or goes, when a turn starts or ends (a user prompt
 * voids a mark) and every `intervalMs` while the office has agents. Returns
 * the stop.
 */
export function watchSessionMarks(
  store: AgentStateStore,
  provider: HookProvider,
  intervalMs: number = SESSION_MARKS_CHECK_MS,
): () => void {
  const marks = provider.sessionMarks;
  let last = JSON.stringify(agentSessionMarks(store, provider));
  const send = (always: boolean) => {
    const message = agentSessionMarksMessage(store, provider);
    const now = JSON.stringify(message.agents);
    if (!always && now === last) return;
    last = now;
    store.broadcast({ ...message });
  };
  const check = () => send(false);
  const onBroadcast = (message: Record<string, unknown>) => {
    if (message.type === 'agentStatus') check();
  };
  store.on('agentAdded', check);
  store.on('agentRemoved', check);
  store.on('broadcast', onBroadcast);
  const stopWatch = marks?.watch(() => send(true));
  const timer = setInterval(() => {
    if (store.size > 0) check();
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    stopWatch?.();
    store.off('agentAdded', check);
    store.off('agentRemoved', check);
    store.off('broadcast', onBroadcast);
  };
}

/**
 * A `setSessionDone`: mark the session done or take its mark off, as the
 * office, then tell every office (agentSessionMarks, broadcast even when no
 * agent's mark changed: it is also what makes the offices ask for their
 * conversation lists again; the office's own write is not reported by the
 * file watcher). Ignored
 * when malformed (the id must be a session UUID) or when the provider keeps
 * no marks; a failed write is logged and changes nothing.
 */
export function setSessionDone(
  store: AgentStateStore,
  provider: HookProvider,
  msg: { sessionId?: unknown; done?: unknown },
): void {
  const marks = provider.sessionMarks;
  if (!marks) return;
  const { sessionId, done } = msg;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
  if (typeof done !== 'boolean') return;
  try {
    marks.setDone(sessionId, done);
  } catch (err) {
    console.error(`[Pixel Agents] Marking session ${sessionId} failed:`, err);
    return;
  }
  console.log(`[Pixel Agents] Session ${sessionId} ${done ? 'marked done' : 'unmarked'}`);
  store.broadcast({ ...agentSessionMarksMessage(store, provider) });
}
