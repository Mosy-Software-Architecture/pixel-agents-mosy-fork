import { execFile } from 'child_process';

import { isRecord } from '../../../../../core/src/isRecord.js';
import type { BackgroundSessionStart, LiveCliSession } from '../../../../../core/src/provider.js';
import {
  CLAUDE_AGENTS_LIST_ARGS,
  CLAUDE_AGENTS_LIST_MAX_AGE_MS,
  CLAUDE_AGENTS_LIST_MAX_BYTES,
  CLAUDE_AGENTS_LIST_RETRY_MS,
  CLAUDE_AGENTS_LIST_TIMEOUT_MS,
  CLAUDE_BACKGROUND_FLAG,
  CLAUDE_BACKGROUND_LOOKUP_ATTEMPTS,
  CLAUDE_BACKGROUND_LOOKUP_INTERVAL_MS,
  CLAUDE_BACKGROUND_START_TIMEOUT_MS,
  CLAUDE_COMMAND,
  CLAUDE_STOP_COMMAND,
  CLAUDE_STOP_TIMEOUT_MS,
} from './constants.js';
import { isInheritedClaudeSessionEnv } from './sessionEnv.js';

/**
 * Claude Code's background sessions (`claude --bg`, 2.1.x): sessions a
 * service runs with no terminal, which outlive whoever started them and are
 * opened with `claude attach <short id>`. `claude agents --json` lists them
 * (and the interactive ones); the registry (liveSessions.ts) has only those
 * whose worker reached its prompt.
 */

/** Runs the CLI and resolves with its stdout; rejects on a non-zero exit, a
 *  timeout or a CLI that is not there (the error's `stderr` says why). */
export type ClaudeCliRunner = (
  args: readonly string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
) => Promise<string>;

/** The real CLI, never through a shell: arguments stay arguments. */
export const runClaudeCli: ClaudeCliRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      CLAUDE_COMMAND,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        maxBuffer: CLAUDE_AGENTS_LIST_MAX_BYTES,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr) }));
        else resolve(String(stdout));
      },
    );
  });

/** This process's environment for the CLI, without the markers of a session
 *  the server itself may run inside (sessionEnv.ts). */
export function claudeCliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isInheritedClaudeSessionEnv(key)) continue;
    env[key] = value;
  }
  return env;
}

/** `claude agents --json` read into live sessions: each entry with a session
 *  id, a background one with its short id and state. Anything else is
 *  skipped; an answer that is not a JSON array is no sessions. */
export function parseAgentsList(raw: string): LiveCliSession[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const sessions: LiveCliSession[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const { sessionId, pid, id, name, status, state, kind } = entry;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    const background = kind === 'background';
    if (background && (typeof id !== 'string' || !id)) continue;
    sessions.push({
      sessionId,
      ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(typeof name === 'string' && name ? { name } : {}),
      ...(typeof status === 'string' && status ? { status } : {}),
      ...(background ? { kind: 'background' as const, backgroundId: id as string } : {}),
      ...(background && typeof state === 'string' && state ? { state } : {}),
    });
  }
  return sessions;
}

/** The last `claude agents --json` answer, asked again when it is old. */
export interface AgentsList {
  /** The last answer, at once. An old one starts a new ask in the background. */
  current(): LiveCliSession[];
  /** Ask now (joining an ask in flight); resolves true when the answer changed. */
  refresh(): Promise<boolean>;
}

export function createAgentsList(
  ask: () => Promise<LiveCliSession[]>,
  opts: { maxAgeMs?: number; retryMs?: number; now?: () => number } = {},
): AgentsList {
  const maxAgeMs = opts.maxAgeMs ?? CLAUDE_AGENTS_LIST_MAX_AGE_MS;
  const retryMs = opts.retryMs ?? CLAUDE_AGENTS_LIST_RETRY_MS;
  const now = opts.now ?? Date.now;
  let sessions: LiveCliSession[] = [];
  /** When the next ask is due on a read. */
  let dueAt = 0;
  let inFlight: Promise<boolean> | null = null;

  function refresh(): Promise<boolean> {
    inFlight ??= ask()
      .then((answer) => {
        const changed = JSON.stringify(answer) !== JSON.stringify(sessions);
        sessions = answer;
        dueAt = now() + maxAgeMs;
        return changed;
      })
      .catch(() => {
        // Keep the last answer: one slow ask must not make running sessions
        // look gone. A CLI that never answered keeps answering nothing.
        dueAt = now() + retryMs;
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    current() {
      if (!inFlight && now() >= dueAt) void refresh();
      return sessions;
    },
    refresh,
  };
}

/** `claude agents --json` through a runner, as live sessions. */
export function askAgentsList(run: ClaudeCliRunner): Promise<LiveCliSession[]> {
  return run(CLAUDE_AGENTS_LIST_ARGS, {
    env: claudeCliEnv(),
    timeoutMs: CLAUDE_AGENTS_LIST_TIMEOUT_MS,
  }).then(parseAgentsList);
}

/** The short id in `claude --bg`'s answer (`backgrounded · 7fdcf719 …`, or the
 *  `claude attach 7fdcf719` hint under it), or undefined. */
export function backgroundedId(stdout: string): string | undefined {
  return (
    /\bbackgrounded\b[^0-9a-f\n]*([0-9a-f]{8})\b/i.exec(stdout)?.[1] ??
    /\bclaude attach ([0-9a-f]{8})\b/.exec(stdout)?.[1]
  );
}

export interface StartBackgroundDeps {
  run: ClaudeCliRunner;
  /** Every live session (registry and list merged), from a fresh ask. */
  lookup: () => Promise<readonly LiveCliSession[]>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Start a background session in `cwd` with `claude --bg` and find its full
 * session id (the list may not have it at once: asked again a few times).
 * Null when the CLI refuses (an older one has no --bg; an untrusted folder or
 * an unaccepted bypass disclaimer needs a terminal to ask in) or never lists
 * the session: the caller launches in a terminal instead.
 */
export async function startBackgroundSession(
  cwd: string,
  opts: { bypassPermissions?: boolean; env: Record<string, string> },
  deps: StartBackgroundDeps,
): Promise<BackgroundSessionStart | null> {
  const args = [CLAUDE_BACKGROUND_FLAG];
  if (opts.bypassPermissions) args.push('--dangerously-skip-permissions');
  let stdout: string;
  try {
    stdout = await deps.run(args, {
      cwd,
      env: opts.env,
      timeoutMs: CLAUDE_BACKGROUND_START_TIMEOUT_MS,
    });
  } catch (err) {
    const why = String((err as { stderr?: string }).stderr ?? '').trim() || String(err);
    console.log(`[Pixel Agents] Background: claude --bg refused in ${cwd}: ${firstLine(why)}`);
    return null;
  }
  const backgroundId = backgroundedId(stdout);
  if (!backgroundId) {
    console.warn(`[Pixel Agents] Background: no session id in claude --bg's answer`);
    return null;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < CLAUDE_BACKGROUND_LOOKUP_ATTEMPTS; attempt++) {
    const found = (await deps.lookup()).find(
      (s) => s.kind === 'background' && s.backgroundId === backgroundId,
    );
    if (found) return { sessionId: found.sessionId, backgroundId };
    await sleep(CLAUDE_BACKGROUND_LOOKUP_INTERVAL_MS);
  }
  console.warn(
    `[Pixel Agents] Background: session ${backgroundId} started but never listed; ` +
      `it keeps running (claude attach ${backgroundId})`,
  );
  return null;
}

/** A background session's short id as the CLI's commands take it: never
 *  anything the CLI could read as a flag. */
const BACKGROUND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Stop the background session `backgroundId` (`claude stop <id>`): its worker
 * ends and its conversation stays. Rejects with the CLI's reason (the first
 * line of what it printed, else the error) when it refuses, fails, times out
 * or is not there, and at once for an id that is not one.
 */
export async function stopBackgroundSession(
  backgroundId: string,
  run: ClaudeCliRunner,
): Promise<void> {
  if (!BACKGROUND_ID_PATTERN.test(backgroundId)) {
    throw new Error(`Not a background session id: ${JSON.stringify(backgroundId)}`);
  }
  try {
    await run([CLAUDE_STOP_COMMAND, backgroundId], {
      env: claudeCliEnv(),
      timeoutMs: CLAUDE_STOP_TIMEOUT_MS,
    });
  } catch (err) {
    const why = String((err as { stderr?: string }).stderr ?? '').trim();
    const reason = firstLine(why) || (err instanceof Error ? err.message : String(err));
    throw new Error(reason);
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}
