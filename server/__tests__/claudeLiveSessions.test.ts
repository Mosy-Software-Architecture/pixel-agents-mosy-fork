import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeSessionsDir, liveSessions } from '../src/providers/hook/claude/liveSessions.js';

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
});
