import { beforeAll, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { startsNoTurn } from '../src/providers/hook/claude/localCommands.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import {
  bashInput,
  bashOutput,
  compactSummary,
  localCommandCaveat,
  modelCommand,
  modelCommandOutput,
  plainPrompt,
  skillCommand,
} from './fixtures/localCommandRecords.js';

const notPrompts = {
  localCommandCaveat,
  modelCommand,
  modelCommandOutput,
  skillCommand,
  bashInput,
  bashOutput,
  compactSummary,
};

describe('startsNoTurn (Claude)', () => {
  it.each(Object.entries(notPrompts))('%s starts no turn', (_name, record) => {
    expect(startsNoTurn(record)).toBe(true);
  });

  it('a prompt starts one, and so does anything that is not user text', () => {
    expect(startsNoTurn(plainPrompt)).toBe(false);
    expect(startsNoTurn({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(
      false,
    );
    expect(startsNoTurn({ type: 'assistant', message: { content: '<command-name>' } })).toBe(false);
    expect(startsNoTurn(null)).toBe(false);
  });
});

describe('transcript parser: local commands', () => {
  beforeAll(() => setHookProvider(claudeProvider));

  function feed(records: Array<Record<string, unknown>>, hookDelivered: boolean) {
    const store = new AgentStateStore();
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: '/p',
        jsonlFile: '/p/s.jsonl',
        isExternal: true,
        isWaiting: true,
        hookDelivered,
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (msg) => sent.push(msg));
    for (const record of records) {
      processTranscriptLine(1, JSON.stringify(record), store, new Map(), new Map());
    }
    return { agent: store.get(1)!, statuses: sent.filter((m) => m.type === 'agentStatus') };
  }

  it.each([false, true])('a /model or !cmd run leaves an idle agent idle (hooks: %s)', (hooks) => {
    const { agent, statuses } = feed(
      [localCommandCaveat, modelCommand, modelCommandOutput, bashInput, bashOutput, compactSummary],
      hooks,
    );
    expect(statuses).toEqual([]);
    expect(agent.isWaiting).toBe(true);
    expect(agent.turnActive).toBeFalsy();
  });

  it('a prompt still starts a turn', () => {
    const { agent, statuses } = feed([plainPrompt], false);
    expect(statuses).toEqual([{ type: 'agentStatus', id: 1, status: 'active' }]);
    expect(agent.turnActive).toBe(true);
  });
});
