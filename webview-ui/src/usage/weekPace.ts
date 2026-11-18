/**
 * How fast a weekly window is being spent against time, for the weekly bar
 * and a model's share of it (both reset together). Pure (no DOM, no clock of
 * its own), so the rules are Node-tested.
 *
 * The bar drains from the right (the share LEFT is the fill, from the left
 * edge), so its timeline runs right to left: the right edge is the window's
 * start, the left edge its reset, and the fill's edge is now.
 *
 * - The fill (what is left) is cut into the days left until the reset, one
 *   block per local calendar day, each as wide as its share of the time left:
 *   the rest of today next to the fill's edge, the day of the reset at the
 *   left edge.
 * - The empty part (what is used) is cut into the days the office saw it
 *   spent (`UsageDailyHistory`, recorded by the server): what was already used
 *   when it started recording at the right edge ("before", unlabelled), then
 *   one block per past day, then today's, as wide as what each spent. Today's
 *   used block and today's block of time left meet at the fill's edge, so
 *   today reads as one block across it.
 * - The pace marker stands where the fill would end if the window were spent
 *   evenly: at the share of the window's time gone. Used more than that is
 *   ahead of pace (spending fast).
 *
 * The usage endpoint gives no window start, so the window is the USAGE_WEEK_MS
 * before its reset.
 */

import { USAGE_WEEK_MS } from '../../../core/src/constants.js';
import type { UsageDailyHistory } from '../../../core/src/messages.js';
import { glyphRects } from '../components/ui/pixelFont.js';

/** Two-letter weekday names, by `Date.getDay()` (Sunday first). Drawn in
 *  capitals in the pixel font on the bar, as written here in the tooltip. */
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

/** Two resets this close are the same window (as the server reckons it). */
const SAME_WINDOW_MS = 60 * 60_000;

/** One day of the timeline, as a share of the whole bar. */
export interface PaceDay {
  /** Local midnight that starts the day (epoch ms). */
  dayStart: number;
  /** "Mo". */
  name: string;
  /** Width of its part of the bar, 0-1. */
  share: number;
}

/** A day still to come (or the rest of today): its time left. */
export interface LeftDay extends PaceDay {
  /** Milliseconds of the window in it (shorter for today and the reset day). */
  durationMs: number;
}

/** A day the office saw spent: what it used, in percentage points. */
export interface UsedDay extends PaceDay {
  used: number;
}

export interface WeekPace {
  /** Share of the window's time gone, 0-1. */
  elapsed: number;
  /** Share of the window used, 0-1. */
  used: number;
  /** Used minus time gone, in whole percentage points. */
  delta: number;
  /** Ahead of pace: used at least a point more than the time gone. */
  ahead: boolean;
  /** "on pace" / "7% ahead of pace". */
  paceText: string;
  /** "Used 29% with 31% of the week gone: on pace". */
  summary: string;
  /** Days left, today first, the reset day last. */
  leftDays: LeftDay[];
  /** Days spent, oldest first, today last; empty without history. */
  usedDays: UsedDay[];
  /** What was used before the office recorded anything (with history), or
   *  everything used (without): drawn unlabelled at the right edge. */
  before: { share: number; since?: number };
  /** The tooltip's lines about the days. */
  dayLines: string[];
}

/** Local midnight that starts the day `ms` falls in. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight that starts the day after the one `ms` falls in (a DST
 *  day is 23 or 25 hours long). */
function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function dayName(ms: number): string {
  return WEEKDAYS[new Date(ms).getDay()];
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "Fr 14:05", local time. */
function shortMoment(ms: number): string {
  const d = new Date(ms);
  return `${dayName(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "9h", "45m": a part of a day. */
function partOfDay(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The pace of a window `usedPercentage` full that resets at `resetsAt` (epoch
 * seconds), at `nowMs`, with the days the server recorded (`daily`, ignored
 * unless the same reset is meant: `dailyResetsAt`). Null once the window has
 * reset (the bar then shows full, with nothing to pace).
 */
export function weekPace(
  window: { usedPercentage: number; resetsAt: number },
  nowMs: number,
  daily?: { history: UsageDailyHistory; resetsAt: number },
): WeekPace | null {
  const endMs = window.resetsAt * 1000;
  if (endMs <= nowMs) return null;
  const startMs = endMs - USAGE_WEEK_MS;
  const elapsed = clamp01((nowMs - startMs) / USAGE_WEEK_MS);
  const used = clamp01(window.usedPercentage / 100);
  const remaining = 1 - used;

  const delta = Math.round((used - elapsed) * 100);
  const ahead = delta >= 1;
  const paceText = ahead ? `${delta}% ahead of pace` : 'on pace';
  const summary = `Used ${Math.round(used * 100)}% with ${Math.round(elapsed * 100)}% of the week gone: ${paceText}`;

  // Time left, one block per local day.
  const leftDays: LeftDay[] = [];
  const timeLeft = endMs - Math.max(nowMs, startMs);
  for (let at = Math.max(nowMs, startMs); at < endMs;) {
    const until = Math.min(nextLocalMidnight(at), endMs);
    const dayStart = localDayStart(at);
    leftDays.push({
      dayStart,
      name: dayName(dayStart),
      share: (remaining * (until - at)) / timeLeft,
      durationMs: until - at,
    });
    at = until;
  }

  // Used, one block per day the office saw.
  const today = localDayStart(nowMs);
  const history =
    daily && Math.abs(daily.resetsAt - window.resetsAt) * 1000 <= SAME_WINDOW_MS
      ? daily.history
      : undefined;
  const usedDays: UsedDay[] = [];
  let before: WeekPace['before'] = { share: used };
  if (history) {
    const usedPoints = Math.min(100, Math.max(0, window.usedPercentage));
    const past = history.days
      .filter((d) => d.dayStart < today)
      .map((d) => ({ dayStart: d.dayStart, used: Math.max(0, d.used) }));
    const beforePoints = Math.max(0, history.usedBefore);
    const recorded = beforePoints + past.reduce((sum, d) => sum + d.used, 0);
    // The bar's number can be fresher than the history (or, rarely, lower):
    // today takes the rest, and the past is scaled down when it overflows.
    const scale = recorded > usedPoints && recorded > 0 ? usedPoints / recorded : 1;
    before = { share: (beforePoints * scale) / 100, since: history.since };
    for (const d of past) {
      usedDays.push({
        dayStart: d.dayStart,
        name: dayName(d.dayStart),
        used: d.used * scale,
        share: (d.used * scale) / 100,
      });
    }
    const todayUsed = Math.max(0, usedPoints - recorded * scale);
    usedDays.push({
      dayStart: today,
      name: dayName(today),
      used: todayUsed,
      share: todayUsed / 100,
    });
  }

  const dayLines: string[] = [];
  if (history) {
    const parts = [
      ...(before.share > 0 ? [`before ${Math.round(before.share * 100)}%`] : []),
      ...usedDays.map(
        (d) => `${d.name} ${Math.round(d.used)}%${d.dayStart === today ? ' (today)' : ''}`,
      ),
    ];
    dayLines.push(`Used by day: ${parts.join(' · ')}`);
    dayLines.push(`Office data since ${shortMoment(history.since)}`);
  } else {
    dayLines.push('Used by day: no history yet (the office records it while it runs)');
  }
  const fullDay = (d: LeftDay) => d.durationMs >= 23 * 3_600_000; // a DST day is 23h
  dayLines.push(
    `Days left: ${leftDays
      .map((d) => (fullDay(d) ? d.name : `${d.name} ${partOfDay(d.durationMs)}`))
      .join(' · ')}`,
  );

  return {
    elapsed,
    used,
    delta,
    ahead,
    paceText,
    summary,
    leftDays,
    usedDays,
    before,
    dayLines,
  };
}

// ── Drawing: whole CSS pixels across the bar ──────────────────

/** A dashed day separator: its column, and whether it is on the fill. */
export interface PaceSeparator {
  x: number;
  onFill: boolean;
}

/** A day's label: its left column, the capitals drawn, and whether it is on the fill. */
export interface PaceLabel {
  x: number;
  text: string;
  width: number;
  onFill: boolean;
}

export interface WeekPaceLayout {
  /** The fill's width (the share left). */
  fillPx: number;
  /** The pace marker's column. */
  markerPx: number;
  /** Ahead of pace: the columns between the fill's edge and the marker. */
  gap?: { from: number; to: number };
  separators: PaceSeparator[];
  labels: PaceLabel[];
}

/** One block of the timeline, right to left. */
interface Block {
  share: number;
  /** Capitals to draw in it; none for "before". */
  label?: string;
}

/**
 * Where to draw a pace on a bar `widthPx` wide, whose first `reservedLeftPx`
 * hold the share-left number (no day label goes there). Separators sit
 * between blocks, never at the bar's ends nor at the fill's edge (already an
 * edge); a label goes inside its block with a pixel to spare on each side,
 * clear of the number, the fill's edge and the marker, as near its centre as
 * it fits, else it is left out (the tooltip lists every day).
 */
export function weekPaceLayout(
  pace: WeekPace,
  widthPx: number,
  reservedLeftPx: number,
): WeekPaceLayout {
  const fillPx = Math.round((1 - pace.used) * widthPx);
  const markerPx = Math.min(widthPx - 1, Math.max(0, Math.round((1 - pace.elapsed) * widthPx)));

  // Right to left: before, the past days, today (used + left), the days left.
  const [todayLeft, ...laterDays] = pace.leftDays;
  const pastDays = pace.usedDays.slice(0, -1);
  const todayUsed = pace.usedDays[pace.usedDays.length - 1];
  const blocks: Block[] = [
    { share: pace.before.share },
    ...pastDays.map((d) => ({ share: d.share, label: d.name.toUpperCase() })),
    {
      share: (todayUsed?.share ?? 0) + (todayLeft?.share ?? 0),
      label: todayLeft?.name.toUpperCase(),
    },
    ...laterDays.map((d) => ({ share: d.share, label: d.name.toUpperCase() })),
  ];
  // Without history the used part is one unlabelled block and today is only
  // its time left: its block starts at the fill's edge.
  if (pace.usedDays.length === 0) {
    blocks[0] = { share: pace.used };
  }

  const separators: PaceSeparator[] = [];
  const labels: PaceLabel[] = [];
  let cum = 0;
  let right = widthPx;
  for (const block of blocks) {
    cum += block.share;
    const left = Math.max(0, Math.round((1 - cum) * widthPx));
    if (left >= right) continue; // narrower than a pixel
    if (left > 0 && left !== fillPx && separators[separators.length - 1]?.x !== left) {
      separators.push({ x: left, onFill: left < fillPx });
    }
    if (block.label) {
      const label = placeLabel(block.label, left, right, { reservedLeftPx, fillPx, markerPx });
      if (label) labels.push(label);
    }
    right = left;
  }

  const gap = pace.ahead && markerPx > fillPx ? { from: fillPx, to: markerPx } : undefined;
  return { fillPx, markerPx, ...(gap ? { gap } : {}), separators, labels };
}

/** The column for a label in the block [left, right), or null when it does not fit. */
function placeLabel(
  text: string,
  left: number,
  right: number,
  avoid: { reservedLeftPx: number; fillPx: number; markerPx: number },
): PaceLabel | null {
  const width = glyphRects(text).width;
  const lo = Math.max(left + 1, avoid.reservedLeftPx);
  const hi = right - 1 - width; // last column it may start at
  if (hi < lo) return null;
  const fits = (x: number) =>
    (x + width <= avoid.fillPx - 1 || x >= avoid.fillPx + 1) &&
    (x + width < avoid.markerPx - 1 || x > avoid.markerPx + 1);
  const centre = Math.round((left + right - width) / 2);
  for (let d = 0; d <= hi - lo; d++) {
    for (const x of [centre - d, centre + d]) {
      if (x >= lo && x <= hi && fits(x)) {
        return { x, text, width, onFill: x + width <= avoid.fillPx };
      }
    }
  }
  return null;
}
