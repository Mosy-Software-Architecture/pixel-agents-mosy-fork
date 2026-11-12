/**
 * What the usage bars show, from the last `usageLimits` the server sent. Pure
 * (no DOM, no clock of its own), so the rules are Node-tested.
 *
 * Reports only arrive while a Claude Code session is open, so the numbers can
 * be old. Two things stay true anyway: a window past its reset time has reset
 * (full bar, whatever was last reported), and the age of the numbers is shown.
 */

import type { UsageLimits, UsagePlanWindow, UsageWindow } from '../../../core/src/messages.js';
import {
  USAGE_BAR_LOW_FRACTION,
  USAGE_BAR_WARN_FRACTION,
  USAGE_HEART_MAX_BPM,
} from '../constants.js';

/** How full a bar reads, which colour band it is in, and what it says. */
export interface UsageBarView {
  /** Share of the window LEFT, 0-1. Null when nothing is known. */
  remaining: number | null;
  level: 'ok' | 'warn' | 'low' | 'unknown';
  /** Shown beside the bar: "73%", or "--" when nothing is known. */
  percent: string;
  /** Shown on hover: "resets in 2h 14m", or why there is no time (empty
   *  when `detail` already says it). */
  reset: string;
  /** Shown on hover before the reset time and as the bar's tooltip: what else
   *  is known ("22% of the weekly budget used, 50% allowed"), or why the bar
   *  is empty. */
  detail?: string;
}

/** The share left of a window `usedPercentage` full, and its colour band. */
function shareLeft(usedPercentage: number): Pick<UsageBarView, 'remaining' | 'level' | 'percent'> {
  const remaining = Math.min(1, Math.max(0, (100 - usedPercentage) / 100));
  const level =
    remaining <= USAGE_BAR_LOW_FRACTION
      ? 'low'
      : remaining <= USAGE_BAR_WARN_FRACTION
        ? 'warn'
        : 'ok';
  return { remaining, level, percent: `${Math.round(remaining * 100)}%` };
}

/** One bar's view of a window at `nowMs`. */
export function usageBarView(window: UsageWindow | undefined, nowMs: number): UsageBarView {
  if (!window) return { remaining: null, level: 'unknown', percent: '--', reset: 'no data yet' };
  const resetAtMs = window.resetsAt * 1000;
  if (resetAtMs <= nowMs) {
    return { remaining: 1, level: 'ok', percent: '100%', reset: 'reset since the last report' };
  }
  return {
    ...shareLeft(window.usedPercentage),
    reset: `resets in ${formatDuration(resetAtMs - nowMs)}`,
  };
}

/** A bar's view of an endpoint window at `nowMs`. */
function planWindowView(window: UsagePlanWindow, nowMs: number): UsageBarView {
  const { usedPercentage, resetsAt, usedPercentOfWeekly, allowancePercentOfWeekly } = window;
  const view =
    resetsAt !== undefined
      ? usageBarView({ usedPercentage, resetsAt }, nowMs)
      : { ...shareLeft(usedPercentage), reset: 'no reset time' };
  const notes = [
    usedPercentOfWeekly !== undefined && allowancePercentOfWeekly !== undefined
      ? `${Math.round(usedPercentOfWeekly)}% of the weekly budget used, ${Math.round(allowancePercentOfWeekly)}% allowed`
      : undefined,
    window.group === 'overage' ? `${Math.round(usedPercentage)}% of extra usage spent` : undefined,
    window.locked ? 'locked' : undefined,
  ].filter((note): note is string => note !== undefined);
  return notes.length > 0 ? { ...view, detail: notes.join(', ') } : view;
}

/** One bar to draw: the weekly or 5-hour one (beside the heart), or an extra
 *  one under them (a model's share of the weekly budget, extra usage). */
export interface UsageBarSpec {
  key: string;
  /** Its name: before its reset time on hover, and left of an extra bar. */
  name: string;
  kind: 'weekly' | 'fiveHour' | 'extra';
  view: UsageBarView;
}

/**
 * The bars to draw, only for the windows the account reports: the weekly bar,
 * the 5-hour bar (none on a plan without that window), then one per scoped or
 * extra-usage window the usage endpoint listed, in its order. The weekly and
 * 5-hour numbers are the freshest of both sources (`sevenDay`/`fiveHour`).
 * With nothing known yet at all, an empty weekly bar ("--") stands in.
 */
export function usageBarSpecs(limits: UsageLimits | undefined, nowMs: number): UsageBarSpec[] {
  const windows = limits?.windows;
  const listed = (group: UsagePlanWindow['group']) => windows?.find((w) => w.group === group);
  const main = (reported: UsageWindow | undefined, listedWindow: UsagePlanWindow | undefined) =>
    reported || !listedWindow ? usageBarView(reported, nowMs) : planWindowView(listedWindow, nowMs);

  const bars: UsageBarSpec[] = [];
  const weekly = listed('weekly');
  const session = listed('session');
  const nothingKnown = !limits?.sevenDay && !limits?.fiveHour && !windows;
  if (limits?.sevenDay || weekly || nothingKnown) {
    bars.push({
      key: 'weekly',
      name: 'Weekly',
      kind: 'weekly',
      view: main(limits?.sevenDay, weekly),
    });
  }
  if (limits?.fiveHour || session) {
    bars.push({
      key: 'fiveHour',
      name: '5-hour',
      kind: 'fiveHour',
      view: main(limits?.fiveHour, session),
    });
  }
  for (const w of windows ?? []) {
    if (w.group !== 'scoped' && w.group !== 'overage') continue;
    bars.push({ key: w.key, name: w.label, kind: 'extra', view: planWindowView(w, nowMs) });
  }
  return bars;
}

/** Seconds per heartbeat for a share left: the pace is proportional to it
 *  (a full plan beats at USAGE_HEART_MAX_BPM), and an empty or unknown plan
 *  has no beat at all (null). */
export function heartBeatPeriodSec(remaining: number | null): number | null {
  if (remaining === null || remaining <= 0) return null;
  return 60 / (USAGE_HEART_MAX_BPM * remaining);
}

/** "3d 4h", "2h 14m", "9m", "<1m" — the two largest units. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/** "updated just now" / "updated 12m ago", or the hint for no report at all
 *  (`providerName`: whose sessions report it). */
export function freshnessLabel(
  updatedAtMs: number | undefined,
  nowMs: number,
  providerName: string,
): string {
  if (updatedAtMs === undefined) return `Updates once a ${providerName} session replies`;
  const age = nowMs - updatedAtMs;
  return age < 60_000 ? 'Updated just now' : `Updated ${formatDuration(age)} ago`;
}

/** Why the account usage endpoint did not answer last time, or undefined
 *  when it did (or was never asked). */
export function endpointNote(
  limits: UsageLimits | undefined,
  providerName: string,
): string | undefined {
  if (limits?.endpointStatus === 'unauthorized') {
    return `Account usage unavailable: sign in to ${providerName} again`;
  }
  if (limits?.endpointStatus === 'offline') return 'Account usage unreachable';
  return undefined;
}
