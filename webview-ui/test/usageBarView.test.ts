import { describe, expect, it } from 'vitest';

import type { UsageLimits } from '../../core/src/messages.js';
import { USAGE_HEART_MAX_BPM } from '../src/constants.js';
import {
  endpointNote,
  formatDuration,
  freshnessLabel,
  heartBeatPeriodSec,
  usageBarSpecs,
  usageBarView,
} from '../src/usage/usageBarView.js';

const NOW = 1_800_000_000_000; // ms
const inMs = (ms: number) => (NOW + ms) / 1000; // a resetsAt (seconds) ms from now

describe('usageBarView', () => {
  it('shows the share left and the time to reset', () => {
    expect(
      usageBarView({ usedPercentage: 18, resetsAt: inMs(2 * 3_600_000 + 14 * 60_000) }, NOW),
    ).toEqual({
      remaining: 0.82,
      level: 'ok',
      percent: '82%',
      reset: 'resets in 2h 14m',
    });
  });

  it('warns at half left and turns low at a fifth', () => {
    expect(usageBarView({ usedPercentage: 50, resetsAt: inMs(60_000) }, NOW).level).toBe('warn');
    expect(usageBarView({ usedPercentage: 80, resetsAt: inMs(60_000) }, NOW).level).toBe('low');
    expect(usageBarView({ usedPercentage: 100, resetsAt: inMs(60_000) }, NOW).remaining).toBe(0);
  });

  it('reads a window past its reset time as full, whatever was last reported', () => {
    expect(usageBarView({ usedPercentage: 97, resetsAt: inMs(-1) }, NOW)).toMatchObject({
      remaining: 1,
      level: 'ok',
    });
  });

  it('says so when nothing is known', () => {
    expect(usageBarView(undefined, NOW)).toEqual({
      remaining: null,
      level: 'unknown',
      percent: '--',
      reset: 'no data yet',
    });
  });
});

describe('heartBeatPeriodSec', () => {
  it('beats at full pace with the whole plan left', () => {
    expect(heartBeatPeriodSec(1)).toBeCloseTo(60 / USAGE_HEART_MAX_BPM);
  });

  it('slows in proportion as the plan runs down', () => {
    expect(heartBeatPeriodSec(0.25)).toBeCloseTo(4 * heartBeatPeriodSec(1)!);
  });

  it('has no beat when the plan is empty or unknown', () => {
    expect(heartBeatPeriodSec(0)).toBeNull();
    expect(heartBeatPeriodSec(null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [30_000, '<1m'],
    [9 * 60_000, '9m'],
    [3_600_000, '1h'],
    [(2 * 60 + 14) * 60_000, '2h 14m'],
    [(3 * 24 + 4) * 3_600_000 + 59_000, '3d 4h'],
    [2 * 24 * 3_600_000, '2d'],
  ])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('freshnessLabel', () => {
  it('names the age of the numbers', () => {
    expect(freshnessLabel(NOW - 10_000, NOW, 'Claude Code')).toBe('Updated just now');
    expect(freshnessLabel(NOW - 12 * 60_000, NOW, 'Claude Code')).toBe('Updated 12m ago');
  });

  it('explains where the numbers will come from before any arrive', () => {
    expect(freshnessLabel(undefined, NOW, 'Claude Code')).toBe(
      'Updates once a Claude Code session replies',
    );
  });
});

/** What the server sends for the account of 2026-11-12: the endpoint listed
 *  the weekly limit and the Fable share of it, and no 5-hour window. */
const ENDPOINT_LIMITS: UsageLimits = {
  type: 'usageLimits',
  providerId: 'claude',
  sevenDay: { usedPercentage: 79, resetsAt: inMs(29 * 3_600_000) },
  windows: [
    {
      key: 'weekly_all',
      label: 'Weekly',
      group: 'weekly',
      usedPercentage: 79,
      resetsAt: inMs(29 * 3_600_000),
    },
    {
      key: 'weekly_scoped:Fable',
      label: 'Fable',
      group: 'scoped',
      usedPercentage: 43,
      resetsAt: inMs(29 * 3_600_000),
      usedPercentOfWeekly: 22,
      allowancePercentOfWeekly: 50,
    },
  ],
  polledAt: NOW,
  endpointStatus: 'ok',
  updatedAt: NOW,
};

describe('usageBarSpecs', () => {
  const summary = (limits: UsageLimits | undefined) =>
    usageBarSpecs(limits, NOW).map((b) => [b.kind, b.name, b.view.percent]);

  it('draws exactly the weekly bar and the Fable share for a plan with no 5-hour window', () => {
    const bars = usageBarSpecs(ENDPOINT_LIMITS, NOW);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ kind: 'weekly', name: 'Weekly', view: { percent: '21%' } });
    expect(bars[1]).toEqual({
      key: 'weekly_scoped:Fable',
      name: 'Fable',
      kind: 'extra',
      view: {
        remaining: 0.57,
        level: 'ok',
        percent: '57%',
        reset: 'resets in 1d 5h',
        detail: '22% of the weekly budget used, 50% allowed',
      },
    });
  });

  it('adds the 5-hour bar again once a report lists the window', () => {
    const fiveHour = { usedPercentage: 10, resetsAt: inMs(60_000) };
    const limits: UsageLimits = {
      ...ENDPOINT_LIMITS,
      fiveHour,
      windows: [
        { key: 'session', label: '5-hour', group: 'session', ...fiveHour },
        ...ENDPOINT_LIMITS.windows!,
      ],
    };
    expect(summary(limits)).toEqual([
      ['weekly', 'Weekly', '21%'],
      ['fiveHour', '5-hour', '90%'],
      ['extra', 'Fable', '57%'],
    ]);
  });

  it('draws the status line windows when the endpoint never answered', () => {
    const fiveHour = { usedPercentage: 10, resetsAt: inMs(60_000) };
    expect(summary({ type: 'usageLimits', providerId: 'claude', fiveHour })).toEqual([
      ['fiveHour', '5-hour', '90%'],
    ]);
  });

  it('stands in an empty weekly bar while nothing is known', () => {
    expect(summary(undefined)).toEqual([['weekly', 'Weekly', '--']]);
    expect(summary({ type: 'usageLimits', providerId: 'claude' })).toEqual([
      ['weekly', 'Weekly', '--'],
    ]);
  });

  it('adds extra usage and a locked model, colour bands as the weekly bar', () => {
    const bars = usageBarSpecs(
      {
        ...ENDPOINT_LIMITS,
        windows: [
          ...ENDPOINT_LIMITS.windows!.slice(0, 1),
          {
            key: 'weekly_scoped:Opus',
            label: 'Opus',
            group: 'scoped',
            usedPercentage: 100,
            locked: true,
          },
          { key: 'extra_usage', label: 'Extra', group: 'overage', usedPercentage: 85 },
        ],
      },
      NOW,
    );
    expect(bars.map((b) => [b.name, b.view.percent, b.view.level, b.view.detail])).toEqual([
      ['Weekly', '21%', 'warn', undefined],
      ['Opus', '0%', 'low', 'locked'],
      ['Extra', '15%', 'low', '85% of extra usage spent'],
    ]);
  });
});

describe('endpointNote', () => {
  it('says why the account usage endpoint did not answer', () => {
    expect(
      endpointNote({ ...ENDPOINT_LIMITS, endpointStatus: 'unauthorized' }, 'Claude Code'),
    ).toBe('Account usage unavailable: sign in to Claude Code again');
    expect(endpointNote({ ...ENDPOINT_LIMITS, endpointStatus: 'offline' }, 'Claude Code')).toBe(
      'Account usage unreachable',
    );
    expect(endpointNote(ENDPOINT_LIMITS, 'Claude Code')).toBeUndefined();
  });
});
