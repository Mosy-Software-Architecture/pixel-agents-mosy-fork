import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../../../../core/src/isRecord.js';
import type { LiveCliSession } from '../../../../../core/src/provider.js';
import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_REGISTRY_BACKGROUND_KIND,
  CLAUDE_SESSIONS_DIR_NAME,
} from './constants.js';

/** Where Claude Code registers its running processes. */
export function claudeSessionsDir(): string {
  const configDir = process.env[CLAUDE_CONFIG_DIR_ENV] || path.join(os.homedir(), '.claude');
  return path.join(configDir, CLAUDE_SESSIONS_DIR_NAME);
}

/**
 * The Claude Code sessions running right now on this host, in any terminal.
 *
 * Each running CLI writes `<pid>.json` to its registry (claudeSessionsDir)
 * with the session it runs, its name and what it is doing, and removes it on
 * exit. A crash leaves the file behind, so an entry counts only while its
 * process is alive. Only the `.json` files are read; the registry keeps other
 * files beside them that are none of the office's business. A background
 * session's worker (`claude --bg`) registers too, once it reaches its prompt,
 * as `kind: "bg"` with its short id in `jobId`.
 */
export function liveSessions(dir: string = claudeSessionsDir()): LiveCliSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: LiveCliSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const entry = readEntry(path.join(dir, name));
    if (entry?.pid !== undefined && isAlive(entry.pid)) sessions.push(entry);
  }
  return sessions;
}

/** One registry file, or null when it isn't one we understand. */
function readEntry(file: string): LiveCliSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null; // Gone, or caught mid-write.
  }
  if (!isRecord(raw)) return null;
  const { pid, sessionId, name, status, kind, jobId } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const background = kind === CLAUDE_REGISTRY_BACKGROUND_KIND;
  return {
    sessionId,
    pid,
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(typeof status === 'string' && status ? { status } : {}),
    ...(background ? { kind: 'background' as const } : {}),
    ...(background && typeof jobId === 'string' && jobId ? { backgroundId: jobId } : {}),
  };
}

/**
 * The registry's sessions with what `claude agents --json` adds: a background
 * session the registry does not have (its worker is in a startup dialog, or
 * not running), and the state of one it has. An interactive process both
 * name is listed once.
 */
export function mergeLiveSessions(
  registry: readonly LiveCliSession[],
  listed: readonly LiveCliSession[],
): LiveCliSession[] {
  const merged = registry.map((session) => ({ ...session }));
  for (const session of listed) {
    if (session.kind === 'background') {
      const known = merged.find(
        (s) => s.kind === 'background' && s.sessionId === session.sessionId,
      );
      if (!known) {
        merged.push({ ...session });
        continue;
      }
      if (session.state) known.state = session.state;
      if (!known.backgroundId && session.backgroundId) known.backgroundId = session.backgroundId;
      if (!known.name && session.name) known.name = session.name;
      continue;
    }
    if (session.pid !== undefined && merged.some((s) => s.pid === session.pid)) continue;
    merged.push({ ...session });
  }
  return merged;
}

/** Whether a process is running. A process we may not signal (EPERM) still is. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
