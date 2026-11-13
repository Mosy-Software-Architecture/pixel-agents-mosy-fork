import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claudeSessionsDir,
  liveSessions,
  mergeLiveSessions,
} from '../src/providers/hook/claude/liveSessions.js';

/**
 * Claude Code's registry of running processes (~/.claude/sessions/<pid>.json):
 * which sessions are open in some terminal right now, so the sidebar can warn
 * before resuming one of them a second time.
 */
describe('Claude live sessions', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-claude-sessions-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function entry(file: string, body: unknown): void {
    fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
  }

  it("lists each running process's session, name and status", () => {
    entry(`${process.pid}.json`, {
      pid: process.pid,
      sessionId: 'abc',
      cwd: '/work',
      name: 'lead',
      nameSource: 'user',
      status: 'idle',
      kind: 'interactive',
    });
    expect(liveSessions(dir)).toEqual([
      { sessionId: 'abc', pid: process.pid, name: 'lead', status: 'idle' },
    ]);
  });

  it('leaves out a crashed process, but keeps one it may not signal', () => {
    entry('101.json', { pid: 101, sessionId: 'dead' });
    entry('102.json', { pid: 102, sessionId: 'other-user' });
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      const code = pid === 101 ? 'ESRCH' : 'EPERM';
      throw Object.assign(new Error(code), { code });
    });
    expect(liveSessions(dir).map((s) => s.sessionId)).toEqual(['other-user']);
  });

  it('skips files it does not understand, and a registry that is missing', () => {
    entry('1.json', '{ torn');
    entry('2.json', { pid: 'x', sessionId: 'a' });
    entry('3.json', { pid: process.pid });
    entry(`${process.pid}.other`, { pid: process.pid, sessionId: 'not-json-name' });
    expect(liveSessions(dir)).toEqual([]);
    expect(liveSessions(path.join(dir, 'missing'))).toEqual([]);
  });

  it("follows Claude Code's config directory", () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/custom/claude');
    expect(claudeSessionsDir()).toBe(path.join('/custom/claude', 'sessions'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect(claudeSessionsDir()).toBe(path.join(os.homedir(), '.claude', 'sessions'));
  });

  it("reads a background session's worker (kind bg) with its short id", () => {
    entry(`${process.pid}.json`, {
      pid: process.pid,
      sessionId: '7fdcf719-fd04-418f-b911-6a99f154c1e5',
      name: '7fdcf719',
      status: 'idle',
      kind: 'bg',
      jobId: '7fdcf719',
    });
    expect(liveSessions(dir)).toEqual([
      {
        sessionId: '7fdcf719-fd04-418f-b911-6a99f154c1e5',
        pid: process.pid,
        name: '7fdcf719',
        status: 'idle',
        kind: 'background',
        backgroundId: '7fdcf719',
      },
    ]);
  });
});

describe('merging the registry with claude agents --json', () => {
  const bg = { kind: 'background' as const };

  it('adds a background session the registry lacks, and the state of one it has', () => {
    const registry = [
      { sessionId: 'a', pid: 10, status: 'busy' },
      { sessionId: 'b', pid: 11, status: 'idle', ...bg, backgroundId: 'b0000000' },
    ];
    const listed = [
      { sessionId: 'a', pid: 10, status: 'busy' },
      {
        sessionId: 'b',
        pid: 11,
        status: 'idle',
        ...bg,
        backgroundId: 'b0000000',
        state: 'blocked',
      },
      // In a startup dialog, or its worker not running: only the list has it.
      { sessionId: 'c', ...bg, backgroundId: 'c0000000', state: 'working', name: 'c' },
    ];
    expect(mergeLiveSessions(registry, listed)).toEqual([
      { sessionId: 'a', pid: 10, status: 'busy' },
      {
        sessionId: 'b',
        pid: 11,
        status: 'idle',
        ...bg,
        backgroundId: 'b0000000',
        state: 'blocked',
      },
      { sessionId: 'c', ...bg, backgroundId: 'c0000000', state: 'working', name: 'c' },
    ]);
  });

  it('keeps an interactive process the registry missed, once', () => {
    expect(mergeLiveSessions([], [{ sessionId: 'x', pid: 5 }])).toEqual([
      { sessionId: 'x', pid: 5 },
    ]);
  });
});
