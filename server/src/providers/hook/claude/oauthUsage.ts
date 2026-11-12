/**
 * The usage bars' second source: the account usage endpoint Claude Code's own
 * `/usage` reads (`GET /api/oauth/usage`), with the OAuth token the CLI
 * already keeps. The status line only forwards the 5-hour and weekly windows;
 * this endpoint reports every window the account has, including a model's
 * share of the weekly budget (Opus, Fable) and extra usage credits.
 *
 * The token is read, never renewed (Claude Code renews it whenever a session
 * runs), never logged and never leaves this machine except to that endpoint.
 * A token past `expiresAt`, a missing one or a 401/403 reads `unauthorized`;
 * anything else that is not a usable answer reads `offline`.
 *
 * The answer, as of 2026-11 (only the fields read here):
 *
 *   "five_hour": null | { "utilization": 12, "resets_at": "2026-…Z" },
 *   "seven_day": { "utilization": 79, "resets_at": "…", "locked_reason": null },
 *   "seven_day_opus": null, "seven_day_sonnet": null, …
 *   "extra_usage": { "is_enabled": false, "utilization": 0, … },
 *   "limits": [
 *     { "kind": "weekly_all", "group": "weekly", "percent": 79, "resets_at": "…", "scope": null },
 *     { "kind": "weekly_scoped", "group": "weekly", "percent": 43, "resets_at": "…",
 *       "scope": { "model": { "display_name": "Fable" } } }
 *   ],
 *   "weekly_scoped_shares": [
 *     { "limit_index": 1, "used_percent_of_weekly": 22, "allowance_percent_of_weekly": 50 }
 *   ]
 *
 * `limits` is the server's own list of meters (a `session` group row is the
 * 5-hour window) and wins; the older top-level windows are the fallback.
 * A share's `limit_index` points into `limits`.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { UsagePlanWindow } from '../../../../../core/src/messages.js';
import type { PolledUsage, ReportedUsage } from '../../../../../core/src/provider.js';
import { isRecord } from '../../../serverConfig.js';
import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CREDENTIALS_FILE_NAME,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_KEYCHAIN_TIMEOUT_MS,
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_USAGE_TIMEOUT_MS,
  CLAUDE_OAUTH_USAGE_URL,
} from './constants.js';

// ── Token ──────────────────────────────────────────────────────

/** The credentials JSON Claude Code keeps, as text, or null when there is none. */
function readCredentialsText(): Promise<string | null> {
  const fromFile = (): string | null => {
    const dir = process.env[CLAUDE_CONFIG_DIR_ENV] || path.join(os.homedir(), '.claude');
    try {
      return fs.readFileSync(path.join(dir, CLAUDE_CREDENTIALS_FILE_NAME), 'utf-8');
    } catch {
      return null;
    }
  };
  // macOS keeps them in the keychain; the file is only an older CLI's leftover.
  if (process.platform !== 'darwin') return Promise.resolve(fromFile());
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS, encoding: 'utf-8' },
      (err, stdout) => resolve(err ? fromFile() : stdout),
    );
  });
}

/** The access token in a credentials JSON, or null when it has none or it
 *  expired (`expiresAt`, epoch ms). Pure. */
export function accessTokenFrom(text: string | null, nowMs: number): string | null {
  if (!text) return null;
  let creds: unknown;
  try {
    creds = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = isRecord(creds) ? creds.claudeAiOauth : undefined;
  if (!isRecord(oauth)) return null;
  const { accessToken, expiresAt } = oauth;
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  if (typeof expiresAt === 'number' && expiresAt <= nowMs) return null;
  return accessToken;
}

// ── Parsing ────────────────────────────────────────────────────

/** Names for the older top-level per-model windows. */
const SCOPED_KEY_LABELS: Record<string, string> = {
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
};

/** "seven_day_omelette" → "Omelette", "seven_day_oauth_apps" → "Oauth apps". */
export function humanizeUsageKey(key: string): string {
  const words = key
    .replace(/^seven_day_|^weekly_/, '')
    .split('_')
    .filter(Boolean);
  if (words.length === 0) return key;
  const text = words.join(' ');
  return text[0].toUpperCase() + text.slice(1);
}

function percentOf(row: Record<string, unknown>): number | undefined {
  const value = row.percent ?? row.utilization;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

/** An ISO time (the endpoint's) or epoch seconds, as epoch seconds. */
function resetsAtOf(row: Record<string, unknown>): number | undefined {
  const value = row.resets_at;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : undefined;
}

function scopeLabel(scope: unknown): string | undefined {
  if (!isRecord(scope)) return undefined;
  for (const part of [scope.model, scope.surface]) {
    if (isRecord(part) && typeof part.display_name === 'string' && part.display_name !== '') {
      return part.display_name;
    }
  }
  return undefined;
}

/** One window from an endpoint row, or undefined without a usable percentage. */
function windowOf(
  row: Record<string, unknown>,
  key: string,
  label: string,
  group: UsagePlanWindow['group'],
): UsagePlanWindow | undefined {
  const usedPercentage = percentOf(row);
  if (usedPercentage === undefined) return undefined;
  const resetsAt = resetsAtOf(row);
  return {
    key,
    label,
    group,
    usedPercentage,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(row.locked_reason ? { locked: true } : {}),
  };
}

/** The windows `limits` lists, each with the row index it came from. */
function windowsFromLimits(rows: unknown[]): Array<[number, UsagePlanWindow]> {
  const out: Array<[number, UsagePlanWindow]> = [];
  rows.forEach((row, index) => {
    if (!isRecord(row)) return;
    const kind = typeof row.kind === 'string' ? row.kind : '';
    let window: UsagePlanWindow | undefined;
    if (row.group === 'session') {
      if (out.some(([, w]) => w.group === 'session')) return;
      window = windowOf(row, kind || 'session', '5-hour', 'session');
    } else if (kind === 'weekly_all') {
      window = windowOf(row, kind, 'Weekly', 'weekly');
    } else if (row.group === 'weekly') {
      const label = scopeLabel(row.scope) ?? humanizeUsageKey(kind || 'scoped');
      window = windowOf(row, `${kind || 'weekly_scoped'}:${label}`, label, 'scoped');
    }
    if (window) out.push([index, window]);
  });
  return out;
}

/** The older top-level per-model windows (`seven_day_opus`, …). */
function scopedFromTopLevel(body: Record<string, unknown>): UsagePlanWindow[] {
  const out: UsagePlanWindow[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('seven_day_') || !isRecord(value)) continue;
    const label = SCOPED_KEY_LABELS[key] ?? humanizeUsageKey(key);
    const window = windowOf(value, key, label, 'scoped');
    if (window) out.push(window);
  }
  return out;
}

/** Fold `weekly_scoped_shares` into the windows: a share whose row is a
 *  window adds its part of the weekly budget; one with no window becomes one
 *  (its share of its allowance). */
function applyShares(
  shares: unknown,
  indexed: Array<[number, UsagePlanWindow]>,
): UsagePlanWindow[] {
  const windows = indexed.map(([, w]) => w);
  if (!Array.isArray(shares)) return windows;
  for (const share of shares) {
    if (!isRecord(share)) continue;
    const { limit_index: index, used_percent_of_weekly: used } = share;
    const allowance = share.allowance_percent_of_weekly;
    if (typeof used !== 'number' || typeof allowance !== 'number' || allowance <= 0) continue;
    const extra = { usedPercentOfWeekly: used, allowancePercentOfWeekly: allowance };
    const at = indexed.findIndex(([i]) => i === index);
    if (at >= 0) {
      windows[at] = { ...windows[at], ...extra };
    } else {
      windows.push({
        key: `share:${String(index)}`,
        label: 'Scoped',
        group: 'scoped',
        usedPercentage: Math.min(100, Math.max(0, (used / allowance) * 100)),
        ...extra,
      });
    }
  }
  return windows;
}

/**
 * The endpoint's answer as windows (in its order: session, weekly, scoped,
 * then extra usage) plus the 5-hour and weekly ones as a ReportedUsage. Null
 * for a body that is not a usage answer (an in-band error, a stranger).
 * Pure: the tests feed it fixtures.
 */
export function parseClaudeOAuthUsage(
  body: unknown,
): { usage: ReportedUsage; windows: UsagePlanWindow[] } | null {
  if (!isRecord(body) || 'error' in body) return null;
  if (!['limits', 'five_hour', 'seven_day'].some((key) => key in body)) return null;

  const rows = Array.isArray(body.limits) ? body.limits : null;
  const indexed = rows ? windowsFromLimits(rows) : [];
  let windows = applyShares(body.weekly_scoped_shares, indexed);
  if (!rows) windows.push(...scopedFromTopLevel(body));

  // The fallbacks for a server that lists no such row.
  if (!windows.some((w) => w.group === 'weekly') && isRecord(body.seven_day)) {
    const weekly = windowOf(body.seven_day, 'weekly_all', 'Weekly', 'weekly');
    if (weekly) windows = [weekly, ...windows];
  }
  if (!windows.some((w) => w.group === 'session') && isRecord(body.five_hour)) {
    const session = windowOf(body.five_hour, 'session', '5-hour', 'session');
    if (session) windows = [session, ...windows];
  }

  const extra = body.extra_usage;
  if (isRecord(extra) && extra.is_enabled === true) {
    const overage = windowOf(extra, 'extra_usage', 'Extra', 'overage');
    if (overage) windows.push(overage);
  }

  const usage: ReportedUsage = {};
  for (const window of windows) {
    if (window.resetsAt === undefined) continue;
    const reported = { usedPercentage: window.usedPercentage, resetsAt: window.resetsAt };
    if (window.group === 'session' && !usage.fiveHour) usage.fiveHour = reported;
    if (window.group === 'weekly' && !usage.sevenDay) usage.sevenDay = reported;
  }
  return { usage, windows };
}

// ── Fetching ───────────────────────────────────────────────────

/** What a read needs from the outside world; the tests replace both. */
export interface OAuthUsageDeps {
  readCredentials: () => Promise<string | null>;
  fetch: typeof fetch;
  now: () => number;
}

const defaultDeps: OAuthUsageDeps = {
  readCredentials: readCredentialsText,
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
};

/** Read the account's usage from the endpoint. Never rejects, never logs the token. */
export async function pollClaudeOAuthUsage(
  deps: OAuthUsageDeps = defaultDeps,
): Promise<PolledUsage> {
  const token = accessTokenFrom(await deps.readCredentials(), deps.now());
  if (!token) return { status: 'unauthorized' };
  try {
    const res = await deps.fetch(CLAUDE_OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(CLAUDE_OAUTH_USAGE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { status: 'unauthorized' };
    if (!res.ok) return { status: 'offline' };
    const parsed = parseClaudeOAuthUsage(await res.json());
    return parsed ? { status: 'ok', ...parsed } : { status: 'offline' };
  } catch {
    return { status: 'offline' };
  }
}
