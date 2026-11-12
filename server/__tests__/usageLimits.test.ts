import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const {
  holdUsagePolling,
  pollUsageEndpointsForTests,
  recordPolledUsage,
  recordUsageReport,
  startUsagePolling,
  usageLimitsMessage,
  usageSnapshotMessages,
  resetUsageLimitsCacheForTests,
} = await import('../src/usageLimits.js');
const { normalizeClaudeUsageReport, normalizeClaudeContextReport } =
  await import('../src/providers/hook/claude/claudeUsageBridge.js');
const { claudeProvider } = await import('../src/providers/index.js');
const { USAGE_ENDPOINT_FRESH_MS, USAGE_POLL_INTERVAL_MS, USAGE_UNCHANGED_REFRESH_MS } =
  await import('../src/constants.js');

const report = (fiveHour?: number, sevenDay?: number) => ({
  rate_limits: {
    ...(fiveHour !== undefined
      ? { five_hour: { used_percentage: fiveHour, resets_at: 1_900_000_000 } }
      : {}),
    ...(sevenDay !== undefined
      ? { seven_day: { used_percentage: sevenDay, resets_at: 1_900_500_000 } }
      : {}),
  },
});

describe('normalizeClaudeUsageReport', () => {
  it('reads both windows', () => {
    expect(normalizeClaudeUsageReport(report(42, 18))).toEqual({
      fiveHour: { usedPercentage: 42, resetsAt: 1_900_000_000 },
      sevenDay: { usedPercentage: 18, resetsAt: 1_900_500_000 },
    });
  });

  it('keeps a window present on its own, and clamps percentages to 0-100', () => {
    expect(normalizeClaudeUsageReport(report(undefined, 140))).toEqual({
      sevenDay: { usedPercentage: 100, resetsAt: 1_900_500_000 },
    });
  });

  it.each([
    ['no body', null],
    ['no rate_limits', { cwd: '/x' }],
    ['no windows', { rate_limits: {} }],
    [
      'a non-numeric percentage',
      { rate_limits: { five_hour: { used_percentage: '4', resets_at: 1 } } },
    ],
    ['no reset time', { rate_limits: { five_hour: { used_percentage: 4 } } }],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeClaudeUsageReport(raw)).toBeNull();
  });
});

describe('normalizeClaudeContextReport', () => {
  const body = (window: unknown, sessionId: unknown = 'sess-1') => ({
    session_id: sessionId,
    context_window: window,
  });

  it("reads the session's share and window", () => {
    expect(
      normalizeClaudeContextReport(body({ used_percentage: 8, context_window_size: 1_000_000 })),
    ).toEqual({ sessionId: 'sess-1', usedPercentage: 8, windowTokens: 1_000_000 });
  });

  it.each([
    ['no session', body({ used_percentage: 8, context_window_size: 200_000 }, null)],
    ['a null share (early in a session)', body({ used_percentage: null, context_window_size: 1 })],
    ['no window size', body({ used_percentage: 8 })],
    ['no context_window', { session_id: 'sess-1' }],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeClaudeContextReport(raw)).toBeNull();
  });
});

describe('recordUsageReport', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-'));
    resetUsageLimitsCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('stores a report and survives a restart', () => {
    expect(recordUsageReport(claudeProvider, report(42, 18), 1000)).toBe(true);

    resetUsageLimitsCacheForTests(); // a new server process
    expect(usageLimitsMessage('claude')).toEqual({
      type: 'usageLimits',
      providerId: 'claude',
      fiveHour: { usedPercentage: 42, resetsAt: 1_900_000_000 },
      sevenDay: { usedPercentage: 18, resetsAt: 1_900_500_000 },
      updatedAt: 1000,
    });
  });

  it('drops an identical report until the last word is old', () => {
    recordUsageReport(claudeProvider, report(42, 18), 1000);
    expect(recordUsageReport(claudeProvider, report(42, 18), 2000)).toBe(false);
    expect(usageLimitsMessage('claude').updatedAt).toBe(1000);
    expect(
      recordUsageReport(claudeProvider, report(42, 18), 1000 + USAGE_UNCHANGED_REFRESH_MS),
    ).toBe(true);
  });

  it('passes on a report that moved the numbers at once', () => {
    recordUsageReport(claudeProvider, report(42, 18), 1000);
    expect(recordUsageReport(claudeProvider, report(43, 18), 1001)).toBe(true);
  });

  it('keeps a window the newest report leaves out', () => {
    recordUsageReport(claudeProvider, report(42, 18), 1000);
    recordUsageReport(claudeProvider, report(undefined, 20), 2000);
    expect(usageLimitsMessage('claude')).toMatchObject({
      fiveHour: { usedPercentage: 42 },
      sevenDay: { usedPercentage: 20 },
    });
  });

  it('ignores a malformed report', () => {
    expect(recordUsageReport(claudeProvider, { rate_limits: 'lots' }, 1000)).toBe(false);
    expect(usageLimitsMessage('claude')).toEqual({ type: 'usageLimits', providerId: 'claude' });
  });

  it('reads a corrupt file as nothing known', () => {
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    fs.writeFileSync(path.join(tmpBase, '.pixel-agents', 'usage-limits.json'), '{ nope');
    expect(usageLimitsMessage('claude')).toEqual({ type: 'usageLimits', providerId: 'claude' });
  });

  it('snapshots each bridged provider: its install state, then its usage', () => {
    recordUsageReport(claudeProvider, report(42, 18), 1000);
    expect(usageSnapshotMessages()).toEqual([
      {
        type: 'usageBridgeStatus',
        providerId: 'claude',
        providerName: 'Claude Code',
        installed: false,
        disclosure: claudeProvider.usageBridge!.disclosure,
      },
      usageLimitsMessage('claude'),
    ]);
  });
});

/** An endpoint answer like the account's of 2026-11-12: no 5-hour window, the
 *  weekly limit and the Fable share of it. */
const WEEKLY = { usedPercentage: 79, resetsAt: 1_900_500_000 };
const FABLE = {
  key: 'weekly_scoped:Fable',
  label: 'Fable',
  group: 'scoped' as const,
  usedPercentage: 43,
  resetsAt: 1_900_500_000,
  usedPercentOfWeekly: 22,
  allowancePercentOfWeekly: 50,
};
const polledNoFiveHour = {
  status: 'ok' as const,
  usage: { sevenDay: WEEKLY },
  windows: [{ key: 'weekly_all', label: 'Weekly', group: 'weekly' as const, ...WEEKLY }, FABLE],
};

describe('recordPolledUsage (the merge rule)', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-'));
    resetUsageLimitsCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('stores every window the endpoint reported, and survives a restart', () => {
    expect(recordPolledUsage('claude', polledNoFiveHour, 1000)).toBe(true);
    resetUsageLimitsCacheForTests();
    expect(usageLimitsMessage('claude')).toEqual({
      type: 'usageLimits',
      providerId: 'claude',
      sevenDay: WEEKLY,
      windows: polledNoFiveHour.windows,
      polledAt: 1000,
      endpointStatus: 'ok',
      updatedAt: 1000,
    });
  });

  it('drops a 5-hour window the endpoint no longer lists', () => {
    recordUsageReport(claudeProvider, report(42, 18), 500);
    recordPolledUsage('claude', polledNoFiveHour, 1000);
    expect(usageLimitsMessage('claude').fiveHour).toBeUndefined();
  });

  it('lets the status line move the numbers between polls, not add a window', () => {
    recordPolledUsage('claude', polledNoFiveHour, 1000);
    expect(recordUsageReport(claudeProvider, report(42, 80), 2000)).toBe(true);
    expect(usageLimitsMessage('claude')).toMatchObject({
      sevenDay: { usedPercentage: 80 },
      windows: polledNoFiveHour.windows,
    });
    expect(usageLimitsMessage('claude').fiveHour).toBeUndefined();
  });

  it('takes the 5-hour window from the status line once the endpoint is stale', () => {
    recordPolledUsage('claude', polledNoFiveHour, 1000);
    recordUsageReport(claudeProvider, report(42, 80), 1000 + USAGE_ENDPOINT_FRESH_MS);
    expect(usageLimitsMessage('claude').fiveHour).toMatchObject({ usedPercentage: 42 });
  });

  it('keeps the last values when a read fails, and says why once', () => {
    recordPolledUsage('claude', polledNoFiveHour, 1000);
    expect(recordPolledUsage('claude', { status: 'unauthorized' }, 70_000)).toBe(true);
    expect(recordPolledUsage('claude', { status: 'unauthorized' }, 130_000)).toBe(false);
    expect(usageLimitsMessage('claude')).toMatchObject({
      sevenDay: WEEKLY,
      windows: polledNoFiveHour.windows,
      polledAt: 1000,
      updatedAt: 1000,
      endpointStatus: 'unauthorized',
    });
  });

  it('records a failure with nothing known yet', () => {
    recordPolledUsage('claude', { status: 'offline' }, 1000);
    expect(usageLimitsMessage('claude')).toEqual({
      type: 'usageLimits',
      providerId: 'claude',
      endpointStatus: 'offline',
    });
  });
});

describe('usage endpoint polling', () => {
  const bridge = claudeProvider.usageBridge!;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-'));
    resetUsageLimitsCacheForTests();
  });

  afterEach(() => {
    resetUsageLimitsCacheForTests();
    vi.restoreAllMocks();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('reads the endpoint at startup and broadcasts the answer', async () => {
    vi.spyOn(bridge, 'isInstalled').mockReturnValue(true);
    const poll = vi.spyOn(bridge, 'pollUsage').mockResolvedValue(polledNoFiveHour);
    const broadcast = vi.fn();
    const stop = startUsagePolling(broadcast);
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledTimes(1));
    expect(poll).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ type: 'usageLimits', windows: [{}, FABLE] });
    stop();
  });

  it('never reads it more often than once a minute, however many offices connect', async () => {
    vi.spyOn(bridge, 'isInstalled').mockReturnValue(true);
    const poll = vi.spyOn(bridge, 'pollUsage').mockResolvedValue(polledNoFiveHour);
    const stop = startUsagePolling(vi.fn());
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    const release = holdUsagePolling();
    const releaseToo = holdUsagePolling();
    await pollUsageEndpointsForTests(Date.now() + 1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await pollUsageEndpointsForTests(Date.now() + USAGE_POLL_INTERVAL_MS + 1000);
    expect(poll).toHaveBeenCalledTimes(2);
    release();
    releaseToo();
    stop();
  });

  it('does not read it while Usage Bars is off', async () => {
    vi.spyOn(bridge, 'isInstalled').mockReturnValue(false);
    const poll = vi.spyOn(bridge, 'pollUsage');
    const stop = startUsagePolling(vi.fn());
    const release = holdUsagePolling();
    await pollUsageEndpointsForTests();
    expect(poll).not.toHaveBeenCalled();
    release();
    stop();
  });
});
