import { afterAll, describe, expect, it } from 'vitest';

// Local days are the point here: pin a zone with a DST change (Europe/Madrid
// goes from UTC+2 to UTC+1 at 03:00 on 2026-10-25).
const previousTz = process.env.TZ;
process.env.TZ = 'Europe/Madrid';
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const { USAGE_WEEK_MS } = await import('../../core/src/constants.js');
const { glyphRects } = await import('../src/components/ui/pixelFont.js');
const { localDayStart, weekPace, weekPaceLayout } = await import('../src/usage/weekPace.js');

const HOUR = 3_600_000;
/** Local time in Madrid, as epoch ms. */
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
/** Epoch ms as the epoch seconds a `resetsAt` is in. */
const secs = (ms: number) => ms / 1000;

// Wednesday 2026-11-18 10:00; the window resets Saturday 2026-11-21 14:00.
const NOW = local(2026, 11, 18, 10);
const RESET = local(2026, 11, 21, 14);
const START = RESET - USAGE_WEEK_MS; // Saturday 2026-11-14 14:00

describe('weekPace: the days left', () => {
  it('cuts the time left into local days, today first and partial, the reset day last', () => {
    const pace = weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, NOW)!;
    expect(pace.leftDays.map((d) => [d.name, d.durationMs / HOUR])).toEqual([
      ['We', 14],
      ['Th', 24],
      ['Fr', 24],
      ['Sa', 14],
    ]);
    expect(pace.leftDays[0].dayStart).toBe(local(2026, 11, 18));
    // Proportional to their time, and together the share left.
    const total = 14 + 24 + 24 + 14;
    expect(pace.leftDays[0].share).toBeCloseTo((0.71 * 14) / total);
    expect(pace.leftDays[1].share).toBeCloseTo((0.71 * 24) / total);
    expect(pace.leftDays.reduce((sum, d) => sum + d.share, 0)).toBeCloseTo(0.71);
    expect(pace.dayLines.at(-1)).toBe('Days left: We 14h · Th · Fr · Sa 14h');
  });

  it('gives a DST day its 25 hours', () => {
    const now = local(2026, 10, 24, 12); // Saturday, the night the clocks go back
    const reset = local(2026, 10, 27, 12);
    const pace = weekPace({ usedPercentage: 50, resetsAt: secs(reset) }, now)!;
    expect(pace.leftDays.map((d) => [d.name, d.durationMs / HOUR])).toEqual([
      ['Sa', 12],
      ['Su', 25],
      ['Mo', 24],
      ['Tu', 12],
    ]);
    expect(pace.leftDays[2].dayStart).toBe(local(2026, 10, 26));
    expect(pace.dayLines.at(-1)).toBe('Days left: Sa 12h · Su · Mo · Tu 12h');
  });

  it('has nothing to pace once the window has reset', () => {
    expect(weekPace({ usedPercentage: 90, resetsAt: secs(NOW - 1) }, NOW)).toBeNull();
  });
});

describe('weekPace: the pace marker', () => {
  it('stands at the share of the week gone, and reads on pace when used is not past it', () => {
    const now = START + 0.31 * USAGE_WEEK_MS;
    const pace = weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, now)!;
    expect(pace.elapsed).toBeCloseTo(0.31);
    expect(pace).toMatchObject({ ahead: false, delta: -2, paceText: 'on pace' });
    expect(pace.summary).toBe('Used 29% with 31% of the week gone: on pace');
    const layout = weekPaceLayout(pace, 150, 0);
    expect(layout.markerPx).toBe(103); // inside the fill
    expect(layout.fillPx).toBe(107);
    expect(layout.gap).toBeUndefined();
  });

  it('reads ahead of pace, with the gap to the fill, when used is past the time gone', () => {
    const now = START + 0.31 * USAGE_WEEK_MS;
    const pace = weekPace({ usedPercentage: 38, resetsAt: secs(RESET) }, now)!;
    expect(pace).toMatchObject({ ahead: true, delta: 7, paceText: '7% ahead of pace' });
    expect(pace.summary).toBe('Used 38% with 31% of the week gone: 7% ahead of pace');
    const layout = weekPaceLayout(pace, 150, 0);
    expect(layout.fillPx).toBe(93);
    expect(layout.markerPx).toBe(103);
    expect(layout.gap).toEqual({ from: 93, to: 103 });
  });

  it('is not ahead by less than a point', () => {
    const now = START + 0.304 * USAGE_WEEK_MS;
    expect(weekPace({ usedPercentage: 30.8, resetsAt: secs(RESET) }, now)!.ahead).toBe(false);
  });
});

describe('weekPace: the days used', () => {
  const daily = (usedBefore: number, days: Array<[number, number]>, since = START + HOUR) => ({
    resetsAt: secs(RESET),
    history: { since, usedBefore, days: days.map(([dayStart, used]) => ({ dayStart, used })) },
  });
  const SAT = local(2026, 11, 14);
  const SUN = local(2026, 11, 15);
  const MON = local(2026, 11, 16);
  const TUE = local(2026, 11, 17);
  const WED = local(2026, 11, 18);

  it('draws one block per past day, today taking the rest of what the bar says is used', () => {
    const pace = weekPace(
      { usedPercentage: 29, resetsAt: secs(RESET) },
      NOW,
      daily(0, [
        [SAT, 2],
        [SUN, 0],
        [MON, 10],
        [TUE, 8],
        [WED, 1], // the server's today is older than the bar's number: recomputed
      ]),
    )!;
    expect(pace.usedDays.map((d) => [d.name, d.used])).toEqual([
      ['Sa', 2],
      ['Su', 0],
      ['Mo', 10],
      ['Tu', 8],
      ['We', 9],
    ]);
    expect(pace.usedDays[2].share).toBeCloseTo(0.1);
    expect(pace.before.share).toBe(0);
    expect(pace.dayLines[0]).toBe('Used by day: Sa 2% · Su 0% · Mo 10% · Tu 8% · We 9% (today)');
  });

  it('lays used and left days out as one timeline, right to left', () => {
    const pace = weekPace(
      { usedPercentage: 30, resetsAt: secs(RESET) },
      NOW,
      daily(0, [
        [MON, 10],
        [TUE, 10],
      ]),
    )!;
    const layout = weekPaceLayout(pace, 150, 0);
    // Fill 105 px; used: Mo [135,150), Tu [120,135), today We's 10% [105,120)
    // joined with We's 14 of 76 hours left [~91,105): no separator at the fill.
    const xs = layout.separators.map((s) => s.x);
    expect(xs).toContain(135);
    expect(xs).toContain(120);
    expect(xs).not.toContain(layout.fillPx);
    expect(xs).toContain(Math.round(150 * (1 - 0.3 - (0.7 * 14) / 76)));
    expect(new Set(xs).size).toBe(xs.length);
    expect(layout.separators.find((s) => s.x === 120)!.onFill).toBe(false);
    expect(layout.separators.find((s) => s.x < layout.fillPx)!.onFill).toBe(true);
    // Day capitals inside their blocks, clear of the fill's edge.
    const mo = layout.labels.find((l) => l.text === 'MO')!;
    expect(mo.x).toBeGreaterThanOrEqual(136);
    expect(mo.x + mo.width).toBeLessThanOrEqual(149);
    expect(mo.onFill).toBe(false);
    for (const label of layout.labels) {
      const crosses = label.x < layout.fillPx && label.x + label.width > layout.fillPx;
      expect(crosses).toBe(false);
    }
  });

  it('draws what was used before the office recorded as one unlabelled block', () => {
    const since = local(2026, 11, 16, 9, 5);
    const pace = weekPace(
      { usedPercentage: 29, resetsAt: secs(RESET) },
      NOW,
      daily(
        12,
        [
          [MON, 6],
          [TUE, 5],
        ],
        since,
      ),
    )!;
    expect(pace.before).toEqual({ share: 0.12, since });
    expect(pace.usedDays.map((d) => d.used)).toEqual([6, 5, 6]);
    expect(pace.dayLines.slice(0, 2)).toEqual([
      'Used by day: before 12% · Mo 6% · Tu 5% · We 6% (today)',
      'Office data since Mo 09:05',
    ]);
    const layout = weekPaceLayout(pace, 150, 0);
    expect(layout.separators.map((s) => s.x)).toContain(Math.round(150 * 0.88)); // before | Mo
    expect(layout.labels.some((l) => l.x >= 132)).toBe(false); // nothing in "before"
  });

  it('without history, the used part is one block and the tooltip says why', () => {
    const pace = weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, NOW)!;
    expect(pace.usedDays).toEqual([]);
    expect(pace.before).toEqual({ share: 0.29 });
    expect(pace.dayLines[0]).toBe(
      'Used by day: no history yet (the office records it while it runs)',
    );
    const layout = weekPaceLayout(pace, 150, 0);
    expect(layout.separators.every((s) => s.onFill)).toBe(true);
  });

  it('ignores the history of another window, and scales an overflowing past down', () => {
    const other = { ...daily(0, [[MON, 10]]), resetsAt: secs(RESET - USAGE_WEEK_MS) };
    expect(weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, NOW, other)!.usedDays).toEqual(
      [],
    );
    const over = weekPace(
      { usedPercentage: 20, resetsAt: secs(RESET) },
      NOW,
      daily(10, [
        [MON, 10],
        [TUE, 20],
      ]),
    )!;
    expect(over.before.share).toBeCloseTo(0.05);
    expect(over.usedDays.map((d) => d.used)).toEqual([5, 10, 0]);
  });
});

describe('weekPaceLayout: labels', () => {
  it('leaves a label out where the number is printed or the block is too narrow', () => {
    const pace = weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, NOW)!;
    const all = weekPaceLayout(pace, 150, 0).labels.map((l) => l.text);
    expect(all).toEqual(['WE', 'TH', 'FR', 'SA']);
    const reserved = 4 + glyphRects('71%').width * 2 + 2;
    const clear = weekPaceLayout(pace, 150, reserved).labels;
    expect(clear.map((l) => l.text)).not.toContain('SA'); // the leftmost block holds "71%"
    expect(clear.every((l) => l.x >= reserved)).toBe(true);
    expect(weekPaceLayout(pace, 20, 0).labels).toEqual([]); // 20 px: no room at all
  });

  it('keeps labels off the marker', () => {
    const pace = weekPace({ usedPercentage: 29, resetsAt: secs(RESET) }, NOW)!;
    const layout = weekPaceLayout(pace, 150, 0);
    for (const l of layout.labels) {
      expect(l.x + l.width < layout.markerPx - 1 || l.x > layout.markerPx + 1).toBe(true);
    }
  });

  it('reads local midnight in the local zone', () => {
    expect(localDayStart(local(2026, 10, 25, 23, 30))).toBe(local(2026, 10, 25));
  });
});
