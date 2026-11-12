import { describe, expect, it } from 'vitest';

import {
  accessTokenFrom,
  humanizeUsageKey,
  type OAuthUsageDeps,
  parseClaudeOAuthUsage,
  pollClaudeOAuthUsage,
} from '../src/providers/hook/claude/oauthUsage.js';

const RESET = '2026-11-13T16:59:59.615915+00:00';
const RESET_S = Date.parse(RESET) / 1000;

/** The real answer of 2026-11-12 (trimmed): no 5-hour window, the weekly
 *  limit, the Fable share of it, extra usage switched off. */
const NO_FIVE_HOUR = {
  five_hour: null,
  seven_day: { utilization: 79, resets_at: RESET, locked_reason: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_omelette: null,
  extra_usage: { is_enabled: false, monthly_limit: 4250, utilization: 0, currency: 'EUR' },
  limits: [
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 79,
      severity: 'warning',
      resets_at: RESET,
      scope: null,
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 43,
      resets_at: RESET,
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
  weekly_scoped_shares: [
    { limit_index: 1, used_percent_of_weekly: 22, allowance_percent_of_weekly: 50 },
  ],
};

/** A session row, a scoped model row and extra usage on. */
const WITH_SESSION = {
  five_hour: { utilization: 12, resets_at: RESET },
  seven_day: { utilization: 30, resets_at: RESET },
  extra_usage: { is_enabled: true, utilization: 15, monthly_limit: 5000, currency: 'USD' },
  limits: [
    { kind: 'session', group: 'session', percent: 12, resets_at: RESET, scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 30, resets_at: RESET, scope: null },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 100,
      resets_at: RESET,
      scope: { model: { display_name: 'Opus' } },
      locked_reason: 'limit_reached',
    },
  ],
};

describe('parseClaudeOAuthUsage', () => {
  it('reads an account with no 5-hour window: the weekly limit and the Fable share', () => {
    expect(parseClaudeOAuthUsage(NO_FIVE_HOUR)).toEqual({
      usage: { sevenDay: { usedPercentage: 79, resetsAt: RESET_S } },
      windows: [
        {
          key: 'weekly_all',
          label: 'Weekly',
          group: 'weekly',
          usedPercentage: 79,
          resetsAt: RESET_S,
        },
        {
          key: 'weekly_scoped:Fable',
          label: 'Fable',
          group: 'scoped',
          usedPercentage: 43,
          resetsAt: RESET_S,
          usedPercentOfWeekly: 22,
          allowancePercentOfWeekly: 50,
        },
      ],
    });
  });

  it('reads a session row as the 5-hour window, a locked scoped row and extra usage', () => {
    expect(parseClaudeOAuthUsage(WITH_SESSION)).toEqual({
      usage: {
        fiveHour: { usedPercentage: 12, resetsAt: RESET_S },
        sevenDay: { usedPercentage: 30, resetsAt: RESET_S },
      },
      windows: [
        {
          key: 'session',
          label: '5-hour',
          group: 'session',
          usedPercentage: 12,
          resetsAt: RESET_S,
        },
        {
          key: 'weekly_all',
          label: 'Weekly',
          group: 'weekly',
          usedPercentage: 30,
          resetsAt: RESET_S,
        },
        {
          key: 'weekly_scoped:Opus',
          label: 'Opus',
          group: 'scoped',
          usedPercentage: 100,
          resetsAt: RESET_S,
          locked: true,
        },
        { key: 'extra_usage', label: 'Extra', group: 'overage', usedPercentage: 15 },
      ],
    });
  });

  it('turns a share with no row into a window of its own: its share of its allowance', () => {
    const body = { ...NO_FIVE_HOUR, limits: [NO_FIVE_HOUR.limits[0]] };
    expect(parseClaudeOAuthUsage(body)?.windows[1]).toEqual({
      key: 'share:1',
      label: 'Scoped',
      group: 'scoped',
      usedPercentage: 44,
      usedPercentOfWeekly: 22,
      allowancePercentOfWeekly: 50,
    });
  });

  it('falls back to the top-level windows when the server lists no rows', () => {
    const parsed = parseClaudeOAuthUsage({
      five_hour: { utilization: 5, resets_at: RESET },
      seven_day: { utilization: 60, resets_at: RESET },
      seven_day_opus: { utilization: 70, resets_at: RESET },
      seven_day_omelette: { utilization: 20, resets_at: RESET },
      seven_day_sonnet: null,
    });
    expect(parsed?.usage).toEqual({
      fiveHour: { usedPercentage: 5, resetsAt: RESET_S },
      sevenDay: { usedPercentage: 60, resetsAt: RESET_S },
    });
    expect(parsed?.windows.map((w) => [w.group, w.label, w.usedPercentage])).toEqual([
      ['session', '5-hour', 5],
      ['weekly', 'Weekly', 60],
      ['scoped', 'Opus', 70],
      ['scoped', 'Omelette', 20],
    ]);
  });

  it.each([
    ['not an object', 'nope'],
    ['an in-band error', { error: { type: 'rate_limit_error' } }],
    ['a stranger', { hello: 'world' }],
  ])('rejects %s', (_label, body) => {
    expect(parseClaudeOAuthUsage(body)).toBeNull();
  });
});

describe('humanizeUsageKey', () => {
  it('drops the window prefix and capitalizes', () => {
    expect(humanizeUsageKey('seven_day_omelette')).toBe('Omelette');
    expect(humanizeUsageKey('seven_day_oauth_apps')).toBe('Oauth apps');
  });
});

describe('accessTokenFrom', () => {
  const creds = (oauth: unknown) => JSON.stringify({ claudeAiOauth: oauth });

  it('reads a live token', () => {
    expect(accessTokenFrom(creds({ accessToken: 'tok', expiresAt: 2000 }), 1000)).toBe('tok');
  });

  it.each([
    ['nothing', null],
    ['not JSON', '{ nope'],
    ['an expired token', creds({ accessToken: 'tok', expiresAt: 1000 })],
    ['no token (API key login)', creds({})],
  ])('has none for %s', (_label, text) => {
    expect(accessTokenFrom(text, 1000)).toBeNull();
  });
});

describe('pollClaudeOAuthUsage', () => {
  const deps = (respond: () => Promise<Response>, token: string | null = 'tok') => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const d: OAuthUsageDeps = {
      readCredentials: async () =>
        token === null ? null : JSON.stringify({ claudeAiOauth: { accessToken: token } }),
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return respond();
      }) as typeof fetch,
      now: () => 1000,
    };
    return { d, calls };
  };

  it('asks the endpoint with the token and reads its answer', async () => {
    const { d, calls } = deps(async () => Response.json(NO_FIVE_HOUR));
    const polled = await pollClaudeOAuthUsage(d);
    expect(polled.status).toBe('ok');
    expect(calls).toEqual([
      {
        url: 'https://api.anthropic.com/api/oauth/usage',
        headers: {
          Authorization: 'Bearer tok',
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
      },
    ]);
  });

  it('reads a refused token as unauthorized', async () => {
    const { d } = deps(async () => new Response('{"error":{}}', { status: 401 }));
    expect(await pollClaudeOAuthUsage(d)).toEqual({ status: 'unauthorized' });
  });

  it('is unauthorized without asking when there is no token', async () => {
    const { d, calls } = deps(async () => Response.json(NO_FIVE_HOUR), null);
    expect(await pollClaudeOAuthUsage(d)).toEqual({ status: 'unauthorized' });
    expect(calls).toEqual([]);
  });

  it('reads a server error, a network failure or a strange body as offline', async () => {
    for (const respond of [
      async () => new Response('', { status: 500 }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => Response.json({ error: { type: 'rate_limit_error' } }),
    ]) {
      expect(await pollClaudeOAuthUsage(deps(respond).d)).toEqual({ status: 'offline' });
    }
  });
});
