import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider, LiveCliSession } from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  backgroundSessionAgents,
  watchBackgroundSessionAgents,
} from '../src/backgroundSessionAgents.js';
import type { AgentState } from '../src/types.js';

/**
 * Which agents' cards may stop their session: only those the CLI lists in
 * its background service (`claude --bg`), never one in another terminal.
 */

function agent(id: number, sessionId: string, extra: Partial<AgentState> = {}): AgentState {
  return { id, sessionId, isExternal: true, ...extra } as AgentState;
}

/** A provider whose live sessions are whatever `sessions` holds right now. */
function providerWith(sessions: { current: LiveCliSession[] }): HookProvider {
  return {
    liveSessions: () => sessions.current,
    refreshLiveSessions: async () => false,
  } as unknown as HookProvider;
}

describe('backgroundSessionAgents', () => {
  it("maps each main agent running a background session to the session's short id", () => {
    const store = new AgentStateStore();
    store.set(1, agent(1, 'bg-session'));
    store.set(2, agent(2, 'terminal-session'));
    store.set(3, agent(3, 'past-session'));
    // A Teammate and a background spawn share or follow a Lead: no card, no skull.
    store.set(4, agent(4, 'bg-session', { leadAgentId: 1 }));
    store.set(5, agent(5, 'bg-session', { spawnToolUseId: 'toolu_1' }));
    const provider = providerWith({
      current: [
        { sessionId: 'bg-session', kind: 'background', backgroundId: '7fdcf719' },
        { sessionId: 'terminal-session', pid: 4242 },
      ],
    });

    expect(backgroundSessionAgents(store, provider)).toEqual({ 1: '7fdcf719' });
  });

  it('is empty for a provider with no live sessions', () => {
    const store = new AgentStateStore();
    store.set(1, agent(1, 'bg-session'));
    expect(backgroundSessionAgents(store, {} as HookProvider)).toEqual({});
  });
});

describe('watchBackgroundSessionAgents', () => {
  afterEach(() => vi.useRealTimers());

  it('broadcasts the map when an agent comes or goes, and when the CLI answers otherwise', async () => {
    vi.useFakeTimers();
    const store = new AgentStateStore();
    const sessions = {
      current: [
        { sessionId: 'bg-session', kind: 'background', backgroundId: '7fdcf719' },
      ] as LiveCliSession[],
    };
    const broadcasts: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => broadcasts.push(m));
    const stop = watchBackgroundSessionAgents(store, providerWith(sessions), 1_000);

    store.set(1, agent(1, 'bg-session'));
    expect(broadcasts).toEqual([{ type: 'agentBackgroundSessions', agents: { 1: '7fdcf719' } }]);

    // Nothing changed: nothing sent.
    store.set(2, agent(2, 'terminal-session'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcasts).toHaveLength(1);

    // The session ended in the background (the CLI's list says so).
    sessions.current = [];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(broadcasts.at(-1)).toEqual({ type: 'agentBackgroundSessions', agents: {} });

    stop();
    sessions.current = [{ sessionId: 'bg-session', kind: 'background', backgroundId: 'x' }];
    await vi.advanceTimersByTimeAsync(5_000);
    store.delete(2);
    expect(broadcasts).toHaveLength(2);
  });
});
