/**
 * The account's plan usage, for the office's usage bars, from two sources:
 *
 * - the provider's usage bridge (Claude: the status line), which reports the
 *   5-hour and weekly windows after each reply of a running session;
 * - the provider's usage endpoint (UsageBridge.pollUsage; Claude: the one
 *   `/usage` reads), which reports every window the account has. It is read
 *   while the bridge is installed (Usage Bars on): once at startup, then every
 *   USAGE_POLL_INTERVAL_MS while a privileged office is connected.
 *
 * Merge rule: an endpoint answer replaces the 5-hour and weekly numbers and the
 * window list; a status line report still moves the numbers in between, but
 * while the endpoint's answer is fresh (USAGE_ENDPOINT_FRESH_MS) it cannot add
 * a window the endpoint did not list. A failed read keeps the last values and
 * only records why (`endpointStatus`).
 *
 * Everything is kept in ~/.pixel-agents/usage-limits.json so a restarted
 * server still has it. Shared by both surfaces.
 *
 * Usage is the operator's account data, so it goes to privileged clients only:
 * the handshake sends it only to them and httpServer drops these broadcasts on
 * read-only sockets (PRIVILEGED_BROADCAST_TYPES).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

import type {
  UsageBridgeStatus,
  UsageEndpointStatus,
  UsageLimits,
  UsagePlanWindow,
  UsageWindow,
} from '../../core/src/messages.js';
import type { HookProvider, PolledUsage, ReportedUsage } from '../../core/src/provider.js';
import {
  PIXEL_AGENTS_DIR,
  USAGE_ENDPOINT_FRESH_MS,
  USAGE_LIMITS_FILE_NAME,
  USAGE_POLL_INTERVAL_MS,
  USAGE_UNCHANGED_REFRESH_MS,
} from './constants.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { hookProviders } from './providers/index.js';
import { isRecord } from './serverConfig.js';

/** What is known of a provider's usage: the freshest 5-hour and weekly
 *  windows and when they moved last, plus the endpoint's last answer. */
interface StoredUsage extends ReportedUsage {
  updatedAt?: number;
  windows?: UsagePlanWindow[];
  polledAt?: number;
  endpointStatus?: UsageEndpointStatus;
}

/** Wire message types only privileged sockets receive. */
export const PRIVILEGED_BROADCAST_TYPES: ReadonlySet<string> = new Set([
  'usageLimits',
  'usageBridgeStatus',
]);

let cache: Record<string, StoredUsage> | null = null;

function usageFilePath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, USAGE_LIMITS_FILE_NAME);
}

function isWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value)) return false;
  const { usedPercentage, resetsAt } = value;
  return (
    typeof usedPercentage === 'number' &&
    Number.isFinite(usedPercentage) &&
    typeof resetsAt === 'number' &&
    Number.isFinite(resetsAt)
  );
}

const PLAN_WINDOW_GROUPS: ReadonlySet<unknown> = new Set([
  'session',
  'weekly',
  'scoped',
  'overage',
]);
const ENDPOINT_STATUSES: ReadonlySet<unknown> = new Set(['ok', 'offline', 'unauthorized']);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlanWindow(value: unknown): value is UsagePlanWindow {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    PLAN_WINDOW_GROUPS.has(value.group) &&
    isFiniteNumber(value.usedPercentage)
  );
}

/** Parse the file's content, keeping only well-formed fields. */
function parseStored(raw: unknown): Record<string, StoredUsage> {
  const out: Record<string, StoredUsage> = {};
  if (!isRecord(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const { fiveHour, sevenDay, updatedAt, windows, polledAt, endpointStatus } = entry;
    out[id] = {
      ...(isFiniteNumber(updatedAt) ? { updatedAt } : {}),
      ...(isWindow(fiveHour) ? { fiveHour } : {}),
      ...(isWindow(sevenDay) ? { sevenDay } : {}),
      ...(Array.isArray(windows) ? { windows: windows.filter(isPlanWindow) } : {}),
      ...(isFiniteNumber(polledAt) ? { polledAt } : {}),
      ...(ENDPOINT_STATUSES.has(endpointStatus)
        ? { endpointStatus: endpointStatus as UsageEndpointStatus }
        : {}),
    };
  }
  return out;
}

function stored(): Record<string, StoredUsage> {
  if (cache) return cache;
  try {
    cache = parseStored(JSON.parse(fs.readFileSync(usageFilePath(), 'utf-8')));
  } catch {
    cache = {}; // absent or unreadable: no usage known yet
  }
  return cache;
}

/** Store `next` for a provider when it says something new: its numbers moved,
 *  or the last word is old enough that "updated N min ago" would mislead.
 *  Returns whether it was stored (and the office should hear about it). */
function commit(providerId: string, next: StoredUsage, now: number): boolean {
  const all = stored();
  const prev = all[providerId];
  const { updatedAt: _prevAt, polledAt: _prevPolled, ...prevRest } = prev ?? {};
  const { updatedAt: _nextAt, polledAt: _nextPolled, ...nextRest } = next;
  const moved = !isDeepStrictEqual(prevRest, nextRest);
  const lastWord = prev?.updatedAt;
  if (!moved && lastWord !== undefined && now - lastWord < USAGE_UNCHANGED_REFRESH_MS) {
    return false;
  }
  all[providerId] = next;
  try {
    writeJsonAtomic(usageFilePath(), all);
  } catch (err) {
    // The office still gets the report; only a restart would lose it.
    console.error('[Pixel Agents] Could not save usage limits:', err);
  }
  return true;
}

/**
 * Take one report from a provider's usage bridge (the status line). Returns
 * true when the office should hear about it. A status line runs on every
 * assistant message, so identical reports in between are dropped, not written.
 *
 * A window missing from the report keeps its last value: Claude Code drops a
 * window once it resets, and the client already shows a window past its reset
 * time as full. While the endpoint's answer is fresh, a 5-hour window it said
 * the account does not have is not taken from the report.
 */
export function recordUsageReport(
  provider: HookProvider,
  raw: unknown,
  now: number = Date.now(),
): boolean {
  const limits = provider.usageBridge?.normalizeReport(raw);
  if (!limits) return false;
  const prev = stored()[provider.id] ?? {};
  const endpointFresh =
    prev.polledAt !== undefined && now - prev.polledAt < USAGE_ENDPOINT_FRESH_MS;
  const noSessionWindow = !prev.windows?.some((w) => w.group === 'session');
  const { fiveHour: _fiveHour, ...rest } = limits;
  const reported: ReportedUsage = endpointFresh && noSessionWindow ? rest : limits;
  if (!reported.fiveHour && !reported.sevenDay) return false;
  return commit(provider.id, { ...prev, ...reported, updatedAt: now }, now);
}

/**
 * Take one read of a provider's usage endpoint. An answer replaces the 5-hour
 * and weekly numbers (no 5-hour window listed = none) and the window list; a
 * failure keeps every value and records only why. Returns true when the office
 * should hear about it.
 */
export function recordPolledUsage(
  providerId: string,
  polled: PolledUsage,
  now: number = Date.now(),
): boolean {
  const prev = stored()[providerId] ?? {};
  if (polled.status !== 'ok') {
    if (prev.endpointStatus === polled.status) return false;
    return commit(providerId, { ...prev, endpointStatus: polled.status }, now);
  }
  const { fiveHour: _fiveHour, sevenDay: _sevenDay, ...kept } = prev;
  const sevenDay = polled.usage.sevenDay ?? prev.sevenDay;
  return commit(
    providerId,
    {
      ...kept,
      ...(polled.usage.fiveHour ? { fiveHour: polled.usage.fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
      windows: polled.windows,
      polledAt: now,
      endpointStatus: 'ok',
      updatedAt: now,
    },
    now,
  );
}

/** The `usageLimits` message for a provider (no windows when none is known). */
export function usageLimitsMessage(providerId: string): UsageLimits {
  const entry = stored()[providerId];
  return { type: 'usageLimits', providerId, ...(entry ?? {}) };
}

/** The `usageBridgeStatus` message: install state, plus why a change failed. */
export function usageBridgeStatusMessage(
  provider: HookProvider,
  error?: string,
): UsageBridgeStatus {
  return {
    type: 'usageBridgeStatus',
    providerId: provider.id,
    providerName: provider.displayName,
    installed: provider.usageBridge?.isInstalled() ?? false,
    disclosure: provider.usageBridge?.disclosure ?? '',
    ...(error ? { error } : {}),
  };
}

/** What a privileged office is told about usage when it connects: for each
 *  provider with a usage bridge, in registration order, its install state and
 *  then its last known usage. Both surfaces' handshakes send exactly this. */
export function usageSnapshotMessages(): Array<UsageBridgeStatus | UsageLimits> {
  return hookProviders
    .filter((provider) => provider.usageBridge)
    .flatMap((provider) => [usageBridgeStatusMessage(provider), usageLimitsMessage(provider.id)]);
}

/**
 * Carry out the Usage Bars toggle: install (the click IS the consent — the
 * disclosure was on screen) or restore the user's status line. Never rejects;
 * answers with the ACTUAL install state and, on failure, the reason, so the
 * checkbox never shows an intent the file doesn't hold.
 */
export async function applyUsageBridgeChoice(
  provider: HookProvider,
  packageRoot: string | undefined,
  enabled: boolean,
): Promise<UsageBridgeStatus> {
  const bridge = provider.usageBridge;
  if (!bridge) return usageBridgeStatusMessage(provider);
  try {
    if (enabled) {
      if (!packageRoot) throw new Error('This server cannot install the usage bridge.');
      await bridge.install(packageRoot);
      void pollUsageEndpoints();
    } else {
      await bridge.uninstall();
    }
    return usageBridgeStatusMessage(provider);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Pixel Agents] ${reason}`);
    return usageBridgeStatusMessage(provider, reason);
  }
}

// ── Polling the usage endpoint ─────────────────────────────────

type UsageBroadcast = (message: UsageLimits) => void;

/** The process's poller: who hears the answers, how many privileged offices
 *  are connected, the timer while there are any, and the last read per provider. */
const polling = {
  broadcast: null as UsageBroadcast | null,
  clients: 0,
  timer: null as ReturnType<typeof setInterval> | null,
  lastPollAt: new Map<string, number>(),
  inFlight: new Set<string>(),
};

/** Read each provider's usage endpoint whose bridge is installed (Usage Bars
 *  on), unless it was read less than USAGE_POLL_INTERVAL_MS ago. */
async function pollUsageEndpoints(now: number = Date.now()): Promise<void> {
  const broadcast = polling.broadcast;
  if (!broadcast) return;
  await Promise.all(
    hookProviders.map(async (provider) => {
      const bridge = provider.usageBridge;
      if (!bridge?.pollUsage || polling.inFlight.has(provider.id)) return;
      const last = polling.lastPollAt.get(provider.id);
      if (last !== undefined && now - last < USAGE_POLL_INTERVAL_MS) return;
      if (!bridge.isInstalled()) return;
      polling.lastPollAt.set(provider.id, now);
      polling.inFlight.add(provider.id);
      try {
        const polled = await bridge.pollUsage().catch((): PolledUsage => ({ status: 'offline' }));
        if (recordPolledUsage(provider.id, polled)) {
          broadcast(usageLimitsMessage(provider.id));
        }
      } finally {
        polling.inFlight.delete(provider.id);
      }
    }),
  );
}

/**
 * Start this process's usage poller (both surfaces call it once, with how to
 * reach every office): one read now, then every USAGE_POLL_INTERVAL_MS while
 * holdUsagePolling has a holder. Returns the stop function.
 */
export function startUsagePolling(broadcast: UsageBroadcast): () => void {
  polling.broadcast = broadcast;
  void pollUsageEndpoints();
  if (polling.clients > 0) startTimer();
  return () => {
    polling.broadcast = null;
    stopTimer();
  };
}

/** A privileged office connected: poll while it stays. Returns its release
 *  (idempotent). The first holder triggers a read when the last is old. */
export function holdUsagePolling(): () => void {
  polling.clients++;
  if (polling.clients === 1) {
    void pollUsageEndpoints();
    startTimer();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    polling.clients--;
    if (polling.clients === 0) stopTimer();
  };
}

function startTimer(): void {
  if (polling.timer || !polling.broadcast) return;
  polling.timer = setInterval(() => void pollUsageEndpoints(), USAGE_POLL_INTERVAL_MS);
  polling.timer.unref?.();
}

function stopTimer(): void {
  if (polling.timer) clearInterval(polling.timer);
  polling.timer = null;
}

/** Tests only: forget the cached file content and the poller's state. */
export function resetUsageLimitsCacheForTests(): void {
  cache = null;
  stopTimer();
  polling.broadcast = null;
  polling.clients = 0;
  polling.lastPollAt.clear();
  polling.inFlight.clear();
}

/** Tests only: run one polling round now. */
export function pollUsageEndpointsForTests(now?: number): Promise<void> {
  return pollUsageEndpoints(now);
}
