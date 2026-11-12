import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  processTranscriptLine,
  setHookProvider,
  setTeamSwitchCallback,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing (mirrors hookEventHandler.test.ts). */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'lead-session',
    terminalRef: undefined,
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

function agentToolUseRecord(toolId: string, name: string, input: Record<string, unknown>) {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResultRecord(toolId: string, text: string) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'text', text }] }],
    },
  });
}

describe('transcriptParser: teammate spawn results (new-harness implicit teams)', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
      setTeamSwitchCallback(() => {});
    };
  });

  it('marks the agent as team lead when an Agent spawn result carries agent_id@team', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', {
        name: 'wa-research',
        subagent_type: 'general-purpose',
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.activeToolNames.get('toolu_1')).toBe('Agent');

    processTranscriptLine(
      1,
      toolResultRecord(
        'toolu_1',
        'Spawned successfully. (internal metadata)\nagent_id: wa-research@session-abc12345\nname: wa-research',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBe(true);
    const teamInfo = messages.find((m) => m.type === 'agentTeamInfo');
    expect(teamInfo).toMatchObject({ id: 1, teamName: 'session-abc12345', isTeamLead: true });
  });

  it('completes the spawn tool normally (no lingering background tool or Subtask)', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'wa-research' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: wa-research@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // The teammate character replaces the transient Subtask one: the spawn tool
    // must be cleared, not parked in backgroundSpawns forever (the new
    // harness never writes the queue-operation completion record).
    expect(agent.backgroundSpawns.size).toBe(0);
    expect(agent.activeToolIds.has('toolu_1')).toBe(false);
    expect(messages.some((m) => m.type === 'subagentClear' && m.parentToolId === 'toolu_1')).toBe(
      true,
    );
  });

  it('does not overwrite team identity already established from record tags', () => {
    // Tag-derived identity (tmux/inline leads) is authoritative over spawn results.
    processTranscriptLine(
      1,
      JSON.stringify({ type: 'assistant', teamName: 'explicit-team', message: { content: [] } }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: helper@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('explicit-team');
  });

  it('re-latches a resumed tag-less lead to the newest team and reports the switch', () => {
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-aaaa1111'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBe('session-aaaa1111');

    // Resume: a new CLI run of the same session mints a fresh implicit team.
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_2', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_2', 'Spawned successfully.\nagent_id: demo-15s@session-bbbb2222'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.teamName).toBe('session-bbbb2222');
    expect(agent.isTeamLead).toBe(true);
    expect(switches).toEqual([{ leadId: 1, previousTeam: 'session-aaaa1111' }]);
    const teamInfos = messages.filter((m) => m.type === 'agentTeamInfo');
    expect(teamInfos[teamInfos.length - 1]).toMatchObject({
      id: 1,
      teamName: 'session-bbbb2222',
      isTeamLead: true,
    });
  });

  it('does not re-latch a teammate that spawns its own named Agent', () => {
    // A teammate session runs through the same processTranscriptLine as its
    // lead. Claude 5 teammates can use the Agent tool, so the teammate's own
    // transcript carries a spawn tool_result naming a NESTED team. Without the
    // leadAgentId guard the teammate re-latches onto that nested team, sets
    // isTeamLead, and linkTeammates detaches it from its real lead.
    const switches: Array<{ leadId: number; previousTeam: string }> = [];
    setTeamSwitchCallback((leadId, previousTeam) => switches.push({ leadId, previousTeam }));

    const teammate = createTestAgent({
      id: 2,
      sessionId: 'teammate-session',
      jsonlFile: '/test/teammate.jsonl',
      // As adopted by fileWatcher: team + lead are pre-set, and
      // teamNameFromTags is NOT set (the tag branch short-circuits because
      // teamName already matches).
      teamName: 'session-aaaa1111',
      agentName: 'helper',
      leadAgentId: 1,
    });
    agents.set(2, teammate);

    processTranscriptLine(
      2,
      agentToolUseRecord('toolu_9', 'Agent', { name: 'nested-helper' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      2,
      toolResultRecord(
        'toolu_9',
        'Spawned successfully.\nagent_id: nested-helper@session-cccc3333',
      ),
      agents,
      waitingTimers,
      permissionTimers,
    );

    // Stays in its own team, stays a teammate, stays attached to its lead.
    expect(teammate.teamName).toBe('session-aaaa1111');
    expect(teammate.isTeamLead).toBeFalsy();
    expect(teammate.leadAgentId).toBe(1);
    expect(switches).toEqual([]);
  });

  it('does not badge an adopted teammate session as LEAD when its lead is not tracked', () => {
    processTranscriptLine(
      1,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.agentName).toBe('demo-15s');
    expect(agent.teamName).toBe('session-abc12345');
    expect(agent.isTeamLead).toBeFalsy();
  });

  it('links an earlier-adopted teammate once the lead latches onto the team', () => {
    const teammate = createTestAgent({ id: 2, sessionId: 'tm-session' });
    agents.set(2, teammate);
    processTranscriptLine(
      2,
      JSON.stringify({
        type: 'user',
        teamName: 'session-abc12345',
        agentName: 'demo-15s',
        message: { content: 'hello' },
      }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(teammate.leadAgentId).toBeUndefined();

    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { name: 'demo-15s' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Spawned successfully.\nagent_id: demo-15s@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );

    expect(agent.isTeamLead).toBe(true);
    expect(teammate.leadAgentId).toBe(1);
    expect(teammate.isTeamLead).toBe(false);
  });

  it('still parks old-style async agent launches as background tools', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Agent', { run_in_background: true }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'Async agent launched successfully.'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.backgroundSpawns.has('toolu_1')).toBe(true);
    expect(agent.activeToolIds.has('toolu_1')).toBe(true);
    expect(agent.teamName).toBeUndefined();
  });

  it('ignores results of non-spawn tools that happen to mention agent_id', () => {
    processTranscriptLine(
      1,
      agentToolUseRecord('toolu_1', 'Read', { file_path: '/tmp/x' }),
      agents,
      waitingTimers,
      permissionTimers,
    );
    processTranscriptLine(
      1,
      toolResultRecord('toolu_1', 'agent_id: someone@session-abc12345'),
      agents,
      waitingTimers,
      permissionTimers,
    );
    expect(agent.teamName).toBeUndefined();
    expect(agent.isTeamLead).toBeUndefined();
  });
});

describe('transcriptParser: questions to the user (AskUserQuestion, ExitPlanMode)', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const line = (l: string) => processTranscriptLine(1, l, agents, waitingTimers, permissionTimers);
  const statuses = () =>
    messages
      .filter((m) => m.type === 'agentStatus')
      .map((m) => (m.awaitingInput ? `${m.status}:input` : m.status));

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (msg) => {
      messages.push(msg as Record<string, unknown>);
    });
    vi.useFakeTimers();
    return () => {
      vi.clearAllTimers();
      vi.useRealTimers();
    };
  });

  for (const toolName of ['AskUserQuestion', 'ExitPlanMode']) {
    it(`a pending ${toolName} call waits for input, with no permission hand`, () => {
      line(agentToolUseRecord('toolu_q', toolName, {}));

      expect(agent.isWaiting).toBe(true);
      expect(statuses()).toEqual(['waiting:input']);
      // The tool row comes first, so the waiting status is the latest word.
      const order = messages.map((m) => m.type);
      expect(order.indexOf('agentToolStart')).toBeLessThan(order.indexOf('agentStatus'));
      vi.advanceTimersByTime(30_000);
      expect(messages.some((m) => m.type === 'agentToolPermission')).toBe(false);
    });
  }

  it('the answer (its tool_result) puts the agent back to work', () => {
    line(agentToolUseRecord('toolu_q', 'AskUserQuestion', {}));
    line(toolResultRecord('toolu_q', 'User answered: yes'));

    expect(agent.isWaiting).toBe(false);
    expect(statuses()).toEqual(['waiting:input', 'active']);
  });

  it('with hooks, the record leaves the hook-driven question alone', () => {
    agent.hookDelivered = true;
    agent.isWaiting = true; // PreToolUse(AskUserQuestion) already said so
    line(agentToolUseRecord('toolu_q', 'AskUserQuestion', {}));
    line(toolResultRecord('toolu_q', 'User answered: yes'));

    expect(statuses()).toEqual([]);
  });

  it('an ordinary tool is work, not a question', () => {
    line(agentToolUseRecord('toolu_r', 'Read', { file_path: '/tmp/x' }));
    expect(statuses()).toEqual(['active']);
    expect(agent.isWaiting).toBe(false);
  });
});

describe('transcriptParser: a lead paused for its background agents (no hooks)', () => {
  // Replays the shape of a real lead transcript (Claude Code 2.1.31x): two
  // Agent spawns launched in the background, a turn_duration while they run,
  // an interim notice, the final notices, the lead's next turn and its end.
  // Only that last end is news for the user (rings): the others are silent
  // or `pausedForSpawns`.
  let agents: AgentStateStore;
  let agent: AgentState;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const line = (record: string) =>
    processTranscriptLine(1, record, agents, waitingTimers, permissionTimers);
  const statuses = () => messages.filter((m) => m.type === 'agentStatus' && m.status === 'waiting');
  const rings = (m: Record<string, unknown>) => !m.silent && !m.pausedForSpawns;
  const turnEnd = JSON.stringify({ type: 'system', subtype: 'turn_duration' });
  const notice = (taskId: string, toolId: string, interim = false) =>
    JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: [
        '<task-notification>',
        `<task-id>${taskId}</task-id>`,
        `<tool-use-id>${toolId}</tool-use-id>`,
        '<status>completed</status>',
        interim
          ? '<summary>Agent "x" is waiting on its own background work</summary>'
          : '<summary>Agent "x" finished</summary>',
        '</task-notification>',
      ].join('\n'),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agent = createTestAgent();
    agents.set(1, agent);
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    line(JSON.stringify({ type: 'user', message: { content: 'Research two things' } }));
    for (const [toolId, taskId] of [
      ['toolu_a', 'a1'],
      ['toolu_b', 'b1'],
    ]) {
      line(agentToolUseRecord(toolId, 'Agent', { description: `Research ${taskId}` }));
      line(
        toolResultRecord(
          toolId,
          `Async agent launched successfully. (internal)\nagentId: ${taskId} (internal)`,
        ),
      );
    }
    messages.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it('turn_duration with live spawns is a pause: pausedForSpawns, no ring', () => {
    line(turnEnd);
    expect(statuses()).toEqual([
      expect.objectContaining({ awaitingInput: false, pausedForSpawns: 2 }),
    ]);
    expect(rings(statuses()[0])).toBe(false);
  });

  it('an interim notice changes nothing; each final one updates the count silently', () => {
    line(turnEnd);
    messages.length = 0;

    line(notice('a1', 'toolu_a', true));
    expect(statuses()).toEqual([]);

    line(notice('a1', 'toolu_a'));
    expect(statuses()).toEqual([expect.objectContaining({ pausedForSpawns: 1, silent: true })]);

    line(notice('b1', 'toolu_b'));
    // The last one leaves the lead at rest, silently: nothing rang yet.
    expect(statuses()).toHaveLength(2);
    expect(statuses()[1]).toMatchObject({ silent: true });
    expect(statuses()[1].pausedForSpawns).toBeUndefined();
    expect(statuses().filter(rings)).toEqual([]);
  });

  it("the lead's turn after the last notice is the real end: it rings once", () => {
    line(turnEnd);
    line(notice('a1', 'toolu_a'));
    line(notice('b1', 'toolu_b'));
    // The notice wakes the lead: Claude writes it as a user record.
    line(JSON.stringify({ type: 'user', message: { content: '<task-notification>…' } }));
    line(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Both done.' }] },
      }),
    );
    line(turnEnd);

    const ringing = statuses().filter(rings);
    expect(ringing).toHaveLength(1);
    expect(ringing[0]).toMatchObject({ awaitingInput: false });
  });

  it('a hand-back turn that ends while another spawn runs is still a pause', () => {
    line(turnEnd);
    line(notice('a1', 'toolu_a'));
    line(
      JSON.stringify({
        type: 'user',
        message: { content: 'Another Claude session sent a message: …' },
      }),
    );
    line(turnEnd);

    expect(statuses().filter(rings)).toEqual([]);
    expect(statuses().at(-1)).toMatchObject({ pausedForSpawns: 1 });
  });
});
