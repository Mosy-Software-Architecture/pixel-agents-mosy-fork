import { afterAll, describe, expect, it } from 'vitest';

// Days are local: pin a zone (Europe/Madrid, UTC+1 in November).
const previousTz = process.env.TZ;
process.env.TZ = 'Europe/Madrid';
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const { appendUsageSample, dailyUsage, isSameUsageWindow, parseUsageHistory } =
  await import('../src/usageHistory.js');
const { USAGE_HISTORY_MAX_SAMPLES, USAGE_HISTORY_MIN_GAP_MS, USAGE_WEEK_MS } =
  await import('../src/constants.js');

const MIN = 60_000;
const HOUR = 60 * MIN;
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

// The window resets Saturday 2026-11-21 14:00 local; it started a week before.
const RESET_MS = local(2026, 11, 21, 14);
const RESETS_AT = RESET_MS / 1000;
const START = RESET_MS - USAGE_WEEK_MS;
const T0 = local(2026, 11, 16, 9); // Monday 09:00

describe('appendUsageSample', () => {
  it('starts a history with the first sample', () => {
    expect(appendUsageSample(undefined, 10, RESETS_AT, T0)).toEqual({
      resetsAt: RESETS_AT,
      samples: [{ t: T0, usedPercentage: 10 }],
    });
  });

  it('samples an unchanged value at most every 5 minutes, a changed one always', () => {
    let h = appendUsageSample(undefined, 10, RESETS_AT, T0);
    const same = appendUsageSample(h, 10, RESETS_AT, T0 + MIN);
    expect(same).toBe(h); // nothing new: the very same object
    h = appendUsageSample(h, 11, RESETS_AT, T0 + 2 * MIN);
    expect(h.samples).toHaveLength(2);
    expect(appendUsageSample(h, 11, RESETS_AT, T0 + 2 * MIN + USAGE_HISTORY_MIN_GAP_MS - 1)).toBe(
      h,
    );
    h = appendUsageSample(h, 11, RESETS_AT, T0 + 2 * MIN + USAGE_HISTORY_MIN_GAP_MS);
    expect(h.samples.map((s) => s.usedPercentage)).toEqual([10, 11, 11]);
  });

  it('never takes a sample older than the last one', () => {
    const h = appendUsageSample(undefined, 10, RESETS_AT, T0);
    expect(appendUsageSample(h, 12, RESETS_AT, T0 - MIN)).toBe(h);
  });

  it('starts over on a new reset time, and treats a jitter of minutes as the same window', () => {
    const h = appendUsageSample(undefined, 40, RESETS_AT, T0);
    expect(isSameUsageWindow(h, RESETS_AT + 300)).toBe(true);
    expect(appendUsageSample(h, 41, RESETS_AT + 300, T0 + MIN).samples).toHaveLength(2);
    const nextWeek = RESETS_AT + USAGE_WEEK_MS / 1000;
    const fresh = appendUsageSample(h, 2, nextWeek, RESET_MS + HOUR);
    expect(fresh).toEqual({
      resetsAt: nextWeek,
      samples: [{ t: RESET_MS + HOUR, usedPercentage: 2 }],
    });
  });

  it('keeps only samples inside the current window', () => {
    const old = { resetsAt: RESETS_AT, samples: [{ t: START - HOUR, usedPercentage: 1 }] };
    expect(appendUsageSample(old, 5, RESETS_AT, T0).samples).toEqual([
      { t: T0, usedPercentage: 5 },
    ]);
    // A read outside the window (a clock off by a week) is not taken.
    expect(appendUsageSample(undefined, 5, RESETS_AT, START - HOUR).samples).toEqual([]);
  });

  it('thins past the cap without changing the days', () => {
    let h = appendUsageSample(undefined, 0, RESETS_AT, START + MIN);
    // A changing value every minute: far past the cap over three days.
    let t = START + MIN;
    let value = 0;
    while (t < START + 3 * 24 * HOUR) {
      t += MIN;
      value += 0.01;
      h = appendUsageSample(h, Math.round(value * 100) / 100, RESETS_AT, t);
    }
    expect(h.samples).toHaveLength(USAGE_HISTORY_MAX_SAMPLES);
    expect(h.samples[0]).toEqual({ t: START + MIN, usedPercentage: 0 });
    expect(h.samples.at(-1)!.t).toBe(t);
    // Every day keeps its last sample, so the days read as before thinning.
    const days = dailyUsage(h)!.days;
    const total = days.reduce((sum, d) => sum + d.used, 0);
    expect(total).toBeCloseTo(h.samples.at(-1)!.usedPercentage);
    expect(days).toHaveLength(4); // Sat (from 14:01), Sun, Mon, Tue (to 14:00)
  });
});

describe('dailyUsage', () => {
  it('is nothing without samples', () => {
    expect(dailyUsage(undefined)).toBeUndefined();
    expect(dailyUsage({ resetsAt: RESETS_AT, samples: [] })).toBeUndefined();
  });

  it('splits at local midnight: a day is its last sample minus the last before it', () => {
    const samples = [
      { t: local(2026, 11, 15, 20), usedPercentage: 12 }, // Sunday: the first sample
      { t: local(2026, 11, 15, 23, 50), usedPercentage: 15 },
      { t: local(2026, 11, 16, 0, 10), usedPercentage: 16 }, // Monday
      { t: local(2026, 11, 16, 18), usedPercentage: 22 },
      { t: local(2026, 11, 18, 9), usedPercentage: 30 }, // Wednesday (none on Tuesday)
    ];
    expect(dailyUsage({ resetsAt: RESETS_AT, samples })).toEqual({
      since: local(2026, 11, 15, 20),
      usedBefore: 12,
      days: [
        { dayStart: local(2026, 11, 15), used: 3 },
        { dayStart: local(2026, 11, 16), used: 7 },
        { dayStart: local(2026, 11, 18), used: 8 },
      ],
    });
  });
});

describe('parseUsageHistory', () => {
  it('keeps the well-formed samples in time order and refuses a malformed history', () => {
    expect(
      parseUsageHistory({
        resetsAt: RESETS_AT,
        samples: [
          { t: 2, usedPercentage: 5 },
          { t: 'x', usedPercentage: 1 },
          { t: 1, usedPercentage: 4, extra: true },
        ],
      }),
    ).toEqual({
      resetsAt: RESETS_AT,
      samples: [
        { t: 1, usedPercentage: 4 },
        { t: 2, usedPercentage: 5 },
      ],
    });
    expect(parseUsageHistory({ samples: [] })).toBeUndefined();
    expect(parseUsageHistory(null)).toBeUndefined();
  });
});
