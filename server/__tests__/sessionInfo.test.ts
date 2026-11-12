import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { seedSessionInfo, updateSessionInfo } from '../src/sessionInfo.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/**
 * The session's name, colour and agent setting over each character: seeded
 * from the transcript when watching starts, then kept current record by
 * record, and re-sent to a connecting office.
 */

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session',
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundSpawns: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';

describe('session info', () => {
  let dir: string;
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-session-info-'));
    agents = new AgentStateStore();
    messages = [];
    agents.on('broadcast', (msg) => messages.push(msg as Record<string, unknown>));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function agentOn(body: string): AgentState {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, body);
    const agent = createTestAgent({ jsonlFile: file });
    agents.set(1, agent);
    return agent;
  }

  it('seeds an adopted agent with its name, colour and agent setting', () => {
    const agent = agentOn(
      line({ type: 'ai-title', aiTitle: 'Generated' }) +
        line({ type: 'custom-title', customTitle: 'lead' }) +
        line({ type: 'agent-color', agentColor: 'Red' }) +
        line({ type: 'agent-setting', agentSetting: 'tools:lead' }) +
        line({ type: 'user' }),
    );
    seedSessionInfo(1, agents, claudeProvider);
    expect(agent.sessionInfo).toEqual({
      title: 'lead',
      titleIsUsers: true,
      color: 'red',
      agentSetting: 'tools:lead',
    });
    expect(messages).toEqual([
      { type: 'agentSessionInfo', id: 1, title: 'lead', color: 'red', agentSetting: 'tools:lead' },
    ]);
  });

  it('tells the office nothing for a session with nothing to show', () => {
    agentOn(line({ type: 'user' }) + line({ type: 'last-prompt', lastPrompt: 'hi' }));
    seedSessionInfo(1, agents, claudeProvider);
    expect(messages).toEqual([]);
  });

  it('keeps a rename over a later generated title, and follows colour changes', () => {
    const agent = agentOn('');
    seedSessionInfo(1, agents, claudeProvider);
    const read = (record: Record<string, unknown>) =>
      updateSessionInfo(1, agent, agents, record, claudeProvider);

    read({ type: 'ai-title', aiTitle: 'Fix the login bug' });
    read({ type: 'custom-title', customTitle: 'login' });
    read({ type: 'ai-title', aiTitle: 'Something else' });
    read({ type: 'agent-color', agentColor: 'blue' });
    read({ type: 'agent-color', agentColor: 'default' });
    // The same name again (Claude Code re-appends it): no new message.
    read({ type: 'custom-title', customTitle: 'login' });

    expect(messages.map((m) => [m.title, m.color])).toEqual([
      ['Fix the login bug', undefined],
      ['login', undefined],
      ['login', 'blue'],
      ['login', undefined],
    ]);
  });

  it('reads the records as transcript lines arrive', () => {
    setHookProvider(claudeProvider);
    const agent = agentOn('');
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'custom-title', customTitle: 'marketing' }),
      agents,
      new Map(),
      new Map(),
    );
    expect(agent.sessionInfo?.title).toBe('marketing');
    expect(messages).toContainEqual({
      type: 'agentSessionInfo',
      id: 1,
      title: 'marketing',
      color: undefined,
      agentSetting: undefined,
    });
  });

  it('re-sends it to a connecting office, after the context', () => {
    agents.set(
      1,
      createTestAgent({
        contextTokens: 10_000,
        sessionInfo: { title: 'lead', titleIsUsers: true, color: 'red' },
      }),
    );
    agents.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), agents);
    expect(sent.map((m) => m.type)).toEqual(['agentContextUsage', 'agentSessionInfo']);
    expect(sent[1]).toMatchObject({ id: 1, title: 'lead', color: 'red' });
  });
});
