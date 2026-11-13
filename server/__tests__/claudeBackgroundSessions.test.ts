import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LiveCliSession } from '../../core/src/provider.js';
import {
  backgroundedId,
  type ClaudeCliRunner,
  createAgentsList,
  parseAgentsList,
  startBackgroundSession,
} from '../src/providers/hook/claude/backgroundSessions.js';
import {
  claudeProvider,
  disableClaudeAgentsList,
  enableClaudeAgentsList,
} from '../src/providers/hook/claude/claude.js';

/**
 * Claude Code's background sessions (`claude --bg`): `claude agents --json`
 * as a second, cached source of live sessions, and starting one for + Agent.
 * The answers below are the shapes Claude Code 2.1.316 printed in a throwaway
 * HOME (see _spikes/oficina-agentes/mos-932-survival.md in the workspace).
 */

const AGENTS_JSON = JSON.stringify([
  {
    pid: 25621,
    id: '095e9c03',
    cwd: '/work',
    kind: 'background',
    startedAt: 1794581066110,
    sessionId: '095e9c03-6c3c-4f90-899f-914b0b082e7b',
    name: 'surv1',
    status: 'idle',
    state: 'blocked',
  },
  // A job whose worker is not running: no pid, no status.
  {
    id: '7fdcf719',
    cwd: '/work',
    kind: 'background',
    sessionId: '7fdcf719-fd04-418f-b911-6a99f154c1e5',
    name: '7fdcf719',
    state: 'working',
  },
  {
    pid: 63707,
    kind: 'interactive',
    sessionId: '3e5330b9-ced5-4d05-b237-9b80349a85be',
    status: 'busy',
  },
  { kind: 'background', sessionId: 'no-short-id' },
  'junk',
]);

describe('claude agents --json', () => {
  it('reads background sessions with their short id and state, and interactive ones', () => {
    expect(parseAgentsList(AGENTS_JSON)).toEqual([
      {
        sessionId: '095e9c03-6c3c-4f90-899f-914b0b082e7b',
        pid: 25621,
        name: 'surv1',
        status: 'idle',
        kind: 'background',
        backgroundId: '095e9c03',
        state: 'blocked',
      },
      {
        sessionId: '7fdcf719-fd04-418f-b911-6a99f154c1e5',
        name: '7fdcf719',
        kind: 'background',
        backgroundId: '7fdcf719',
        state: 'working',
      },
      { sessionId: '3e5330b9-ced5-4d05-b237-9b80349a85be', pid: 63707, status: 'busy' },
    ]);
  });

  it('reads anything else as no sessions', () => {
    expect(parseAgentsList('error: unknown command agents')).toEqual([]);
    expect(parseAgentsList('{"a":1}')).toEqual([]);
  });
});

describe('the cached list', () => {
  const one: LiveCliSession[] = [{ sessionId: 's', kind: 'background', backgroundId: 's0000000' }];

  it('answers at once from the last answer and asks again in the background when it is old', async () => {
    let now = 0;
    let asks = 0;
    const list = createAgentsList(
      async () => {
        asks++;
        return one;
      },
      { maxAgeMs: 1_000, now: () => now },
    );

    expect(list.current()).toEqual([]); // nothing yet; an ask starts
    expect(asks).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(list.current()).toEqual(one);
    expect(asks).toBe(1); // fresh: no new ask
    now = 1_000;
    list.current();
    expect(asks).toBe(2);
  });

  it('joins an ask in flight and says whether the answer changed', async () => {
    let asks = 0;
    const list = createAgentsList(async () => {
      asks++;
      return one;
    });
    const [first, second] = await Promise.all([list.refresh(), list.refresh()]);
    expect(asks).toBe(1);
    expect([first, second]).toEqual([true, true]);
    expect(await list.refresh()).toBe(false);
  });

  it('keeps the last answer when an ask fails, and waits longer before the next', async () => {
    let now = 0;
    let fail = false;
    let asks = 0;
    const list = createAgentsList(
      async () => {
        asks++;
        if (fail) throw new Error('timed out');
        return one;
      },
      { maxAgeMs: 1_000, retryMs: 60_000, now: () => now },
    );
    await list.refresh();
    fail = true;
    now = 1_000;
    expect(await list.refresh()).toBe(false);
    expect(list.current()).toEqual(one);
    now = 30_000;
    list.current();
    expect(asks).toBe(2);
  });
});

describe('starting a background session (+ Agent)', () => {
  const sessionId = '7fdcf719-fd04-418f-b911-6a99f154c1e5';
  const listed: LiveCliSession = { sessionId, kind: 'background', backgroundId: '7fdcf719' };
  const answer =
    'backgrounded · 7fdcf719 (idle — send a prompt to start)\n  claude attach 7fdcf719    open in this terminal\n';

  it('finds the short id in what claude --bg prints', () => {
    expect(backgroundedId(answer)).toBe('7fdcf719');
    expect(backgroundedId('backgrounded · 095e9c03 · surv1')).toBe('095e9c03');
    expect(backgroundedId('nothing here')).toBeUndefined();
  });

  it('runs claude --bg in the Directory and finds the full id, asking again while it is not listed', async () => {
    const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
    const run: ClaudeCliRunner = async (args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return answer;
    };
    let lookups = 0;
    const started = await startBackgroundSession(
      '/work',
      { bypassPermissions: true, env: {} },
      {
        run,
        lookup: async () => (++lookups < 3 ? [] : [listed]),
        sleep: async () => {},
      },
    );

    expect(calls).toEqual([{ args: ['--bg', '--dangerously-skip-permissions'], cwd: '/work' }]);
    expect(lookups).toBe(3);
    expect(started).toEqual({ sessionId, backgroundId: '7fdcf719' });
  });

  it('gives up (the caller launches in a terminal) when the CLI refuses or never lists it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing: ClaudeCliRunner = () =>
      Promise.reject(
        Object.assign(new Error('exit 1'), {
          stderr: 'Workspace not trusted. Run `claude` in /work once and accept the trust prompt',
        }),
      );
    expect(
      await startBackgroundSession('/work', { env: {} }, { run: refusing, lookup: async () => [] }),
    ).toBeNull();
    expect(log.mock.calls[0]?.[0]).toContain('Workspace not trusted');

    expect(
      await startBackgroundSession(
        '/work',
        { env: {} },
        { run: async () => answer, lookup: async () => [], sleep: async () => {} },
      ),
    ).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toContain('claude attach 7fdcf719');
    log.mockRestore();
    warn.mockRestore();
  });
});

describe('the Claude provider', () => {
  afterEach(() => disableClaudeAgentsList());

  it('attaches to a background session instead of resuming it', () => {
    expect(claudeProvider.buildLaunchCommand!('id', '/work', { attach: '7fdcf719' })).toEqual({
      command: 'claude',
      args: ['attach', '7fdcf719'],
      env: { PWD: '/work' },
    });
  });

  it('asks the CLI only once turned on, and lists what it answers', async () => {
    expect(claudeProvider.startBackgroundSession!('/work', { env: {} })).toBeNull();
    const asked: Array<readonly string[]> = [];
    enableClaudeAgentsList(async (args) => {
      asked.push(args);
      return AGENTS_JSON;
    });
    expect(await claudeProvider.refreshLiveSessions!()).toBe(true);
    expect(asked).toEqual([['agents', '--json']]);
    expect(
      claudeProvider.liveSessions!()
        .filter((s) => s.kind === 'background')
        .map((s) => s.backgroundId),
    ).toEqual(['095e9c03', '7fdcf719']);
  });
});
