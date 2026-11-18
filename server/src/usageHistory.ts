/**
 * The usage bars' days: the account usage endpoint says how much of a weekly
 * window is used, never when it was used, so the server keeps its own record.
 * Each successful read adds a sample `{ t, usedPercentage }` to the window's
 * history (per window key, in usage-limits.json), and the office is sent the
 * consumption per local day worked out from them (`dailyUsage`).
 *
 * Rules (appendUsageSample):
 * - only samples inside the current window are taken and kept (the window is taken to
 *   be the USAGE_WEEK_MS before `resetsAt`: the endpoint gives no start);
 * - a `resetsAt` more than USAGE_HISTORY_SAME_WINDOW_MS away from the stored
 *   one is a new window and starts a fresh history;
 * - an unchanged value is sampled at most every USAGE_HISTORY_MIN_GAP_MS, a
 *   changed one always;
 * - past USAGE_HISTORY_MAX_SAMPLES, the oldest sample that is neither the
 *   first nor the last of its day goes, so the days read the same.
 *
 * Days are the server's local calendar days. Pure apart from the local time
 * zone (Date), so the rules are Node-tested.
 */

import type { UsageDailyHistory, UsageDay, UsagePlanWindow } from '../../core/src/messages.js';
import {
  USAGE_HISTORY_MAX_SAMPLES,
  USAGE_HISTORY_MIN_GAP_MS,
  USAGE_HISTORY_SAME_WINDOW_MS,
  USAGE_WEEK_MS,
} from './constants.js';
import { isRecord } from './serverConfig.js';

/** One read of a window: when (epoch ms) and how much of it was used (0-100). */
export interface UsageSample {
  t: number;
  usedPercentage: number;
}

/** A window's recorded samples, oldest first, and the reset they belong to
 *  (epoch SECONDS, as the endpoint states it). */
export interface UsageWindowHistory {
  resetsAt: number;
  samples: UsageSample[];
}

/** The window groups whose days the office draws: the weekly window and a
 *  model's share of it (both reset together, a week apart). */
export function keepsHistory(window: UsagePlanWindow): boolean {
  return (window.group === 'weekly' || window.group === 'scoped') && window.resetsAt !== undefined;
}

/** Local midnight that starts the day `ms` falls in. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A stored history as read from the file, or undefined when malformed
 *  (malformed samples are dropped, the rest kept in time order). */
export function parseUsageHistory(raw: unknown): UsageWindowHistory | undefined {
  if (!isRecord(raw) || !isFiniteNumber(raw.resetsAt) || !Array.isArray(raw.samples)) {
    return undefined;
  }
  const samples = raw.samples
    .filter(
      (s): s is UsageSample =>
        isRecord(s) && isFiniteNumber(s.t) && isFiniteNumber(s.usedPercentage),
    )
    .map(({ t, usedPercentage }) => ({ t, usedPercentage }))
    .sort((a, b) => a.t - b.t);
  return { resetsAt: raw.resetsAt, samples };
}

/** Whether a history belongs to the window resetting at `resetsAt` (epoch
 *  seconds): the same reset, give or take USAGE_HISTORY_SAME_WINDOW_MS. */
export function isSameUsageWindow(history: UsageWindowHistory, resetsAt: number): boolean {
  return Math.abs(history.resetsAt - resetsAt) * 1000 <= USAGE_HISTORY_SAME_WINDOW_MS;
}

/** Drop the oldest sample that the days do not need: one followed by another
 *  sample of the same day (never the first, which is the baseline). */
function thinOnce(samples: UsageSample[]): UsageSample[] {
  for (let i = 1; i < samples.length - 1; i++) {
    if (localDayStart(samples[i].t) === localDayStart(samples[i + 1].t)) {
      return [...samples.slice(0, i), ...samples.slice(i + 1)];
    }
  }
  return samples.slice(1); // every sample ends its day: drop the oldest
}

/**
 * `history` with the sample `usedPercentage` at `now` for a window resetting
 * at `resetsAt` (epoch seconds), following the rules above. Returns `history`
 * itself when nothing changes, so callers can tell.
 */
export function appendUsageSample(
  history: UsageWindowHistory | undefined,
  usedPercentage: number,
  resetsAt: number,
  now: number,
): UsageWindowHistory {
  const sameWindow = history !== undefined && isSameUsageWindow(history, resetsAt);
  const windowStart = resetsAt * 1000 - USAGE_WEEK_MS;
  const kept = sameWindow ? history.samples.filter((s) => s.t >= windowStart) : [];
  const last = kept[kept.length - 1];
  const inWindow = now >= windowStart && now < resetsAt * 1000;
  const changed = last !== undefined && last.usedPercentage !== usedPercentage;
  const due =
    inWindow && (!last || (now > last.t && (changed || now - last.t >= USAGE_HISTORY_MIN_GAP_MS)));
  if (sameWindow && kept.length === history.samples.length && !due) return history;
  let samples = due ? [...kept, { t: now, usedPercentage }] : kept;
  while (samples.length > USAGE_HISTORY_MAX_SAMPLES) samples = thinOnce(samples);
  return { resetsAt: sameWindow ? history.resetsAt : resetsAt, samples };
}

/**
 * The consumption per local day from a window's samples: a day's share is its
 * last sample minus the last sample before it (the first day's, the first
 * sample), and what was used before the first sample is `usedBefore`.
 * Undefined with no samples.
 */
export function dailyUsage(history: UsageWindowHistory | undefined): UsageDailyHistory | undefined {
  const samples = history?.samples ?? [];
  if (samples.length === 0) return undefined;
  const first = samples[0];
  const days: UsageDay[] = [];
  let before = first.usedPercentage;
  for (let i = 0; i < samples.length; i++) {
    const dayStart = localDayStart(samples[i].t);
    const next = samples[i + 1];
    if (next && localDayStart(next.t) === dayStart) continue; // not the day's last
    days.push({ dayStart, used: samples[i].usedPercentage - before });
    before = samples[i].usedPercentage;
  }
  return { since: first.t, usedBefore: first.usedPercentage, days };
}
