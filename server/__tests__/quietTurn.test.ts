import { describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { QUIET_TURN_IDLE_MS } from '../src/constants.js';
import { endQuietTurns, isQuietTurn } from '../src/timerManager.js';
import type { AgentState } from '../src/types.js';

const NOW = 1_000_000_000;

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    sessionId: 's',
    projectDir: '/p',
    jsonlFile: '/p/s.jsonl',
    isExternal: true,
    turnActive: true,
    lastDataAt: NOW - QUIET_TURN_IDLE_MS - 1,
    ...overrides,
  });
}

describe('isQuietTurn', () => {
  it('takes an active turn with no tool running and nothing written for too long as ended', () => {
    expect(isQuietTurn(agent(), NOW)).toBe(true);
  });

  it('waits out the quiet period', () => {
    expect(isQuietTurn(agent({ lastDataAt: NOW - QUIET_TURN_IDLE_MS }), NOW)).toBe(false);
  });

  it('leaves a running foreground tool alone, however long it runs', () => {
    expect(isQuietTurn(agent({ activeToolIds: new Set(['t1']) }), NOW)).toBe(false);
  });

  it('does not count a live background spawn as a running tool', () => {
    const a = agent({ activeToolIds: new Set(['bg']) });
    a.backgroundSpawns.set('bg', { taskId: 'task' });
    expect(isQuietTurn(a, NOW)).toBe(true);
  });

  it('ignores agents already waiting, at rest, or driven by hooks', () => {
    expect(isQuietTurn(agent({ isWaiting: true }), NOW)).toBe(false);
    expect(isQuietTurn(agent({ turnActive: false }), NOW)).toBe(false);
    expect(isQuietTurn(agent({ hookDelivered: true }), NOW)).toBe(false);
  });
});

describe('endQuietTurns', () => {
  it('marks a quiet agent waiting ("Done") once and leaves the others', () => {
    const store = new AgentStateStore();
    store.set(1, agent({ id: 1 }));
    store.set(2, agent({ id: 2, lastDataAt: NOW }));
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (msg) => sent.push(msg));

    endQuietTurns(store, new Map(), NOW);
    endQuietTurns(store, new Map(), NOW + QUIET_TURN_IDLE_MS);

    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false }]);
    expect(store.get(1)?.isWaiting).toBe(true);
    expect(store.get(1)?.turnActive).toBe(false);
    expect(store.get(2)?.isWaiting).toBe(false);
  });
});
