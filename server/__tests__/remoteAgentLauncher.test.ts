import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { RemoteHost } from '../src/configPersistence.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { RemoteSession } from '../src/providers/hook/claude/remoteListing.js';
import { mirrorPath } from '../src/remoteHosts.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import { launchRemoteAgent } from '../src/terminal/remoteAgentLauncher.js';

/**
 * A remote host's session opened in the office: an ssh terminal into the
 * host's tmux, and a character fed by the transcript's tail. The tail is a
 * stand-in script printing what `ssh host tail -F` would; the PTY is fake.
 */

class FakePty implements IPty {
  readonly pid = 4343;
  private exitListener: ((e: { exitCode: number }) => void) | null = null;
  onData(): void {}
  onExit(listener: (e: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  write(): void {}
  resize(): void {}
  kill(): void {
    this.exitListener?.({ exitCode: 0 });
  }
}

const casita: RemoteHost = { name: 'casita', ssh: 'minipc' };
const ID = '5c849872-d975-4bda-8c86-64d926e54fa6';
const rec = (record: Record<string, unknown>) => JSON.stringify(record);

const session: RemoteSession = {
  sessionId: ID,
  transcript: '/home/u/.claude/projects/-home-u-dev/x.jsonl',
  cwd: '/home/u/dev',
  updatedAt: 1_000,
  title: 'mos-884-outreach',
  labelLines: [
    rec({ type: 'custom-title', customTitle: 'mos-884-outreach' }),
    rec({ type: 'agent-color', agentColor: 'red' }),
  ],
  tmux: 'mos-884-outreach',
};

/** Wait until `check` holds (the poll and watcher run on real timers). */
async function until(check: () => boolean, ms = 6_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('launchRemoteAgent', () => {
  let dir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let broadcasts: Array<Record<string, unknown>>;
  let spawned: Array<{ file: string; args: string[] }>;
  let ptys: FakePty[];
  let manager: PtySessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-remote-'));
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));
    spawned = [];
    ptys = [];
    const module: PtyModule = {
      spawn: (file, args) => {
        spawned.push({ file, args });
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    };
    manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for the ssh tail: prints `lines`, then waits. */
  function tail(lines: string[]): string {
    const script = path.join(dir, `tail-${fs.readdirSync(dir).length}.sh`);
    const body = lines.map((l) => `printf '%s\\n' '${l}'`).join('\n');
    fs.writeFileSync(script, `#!/bin/sh\nsleep 0.3\n${body}\nsleep 30\n`, { mode: 0o755 });
    return script;
  }

  it('attaches over ssh and feeds the transcript tail to the parser, under the host', async () => {
    const toolUse = rec({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.ts' } }],
      },
    });
    const deps = { store, runtime, ptyManager: manager, provider: claudeProvider };
    const id = launchRemoteAgent(deps, casita, session, tail([toolUse]))!;

    expect(spawned[0]).toEqual({
      file: 'ssh',
      args: [
        '-t',
        'minipc',
        `tmux new-session -A -s 'mos-884-outreach' -c '/home/u/dev' 'claude --resume ${ID}'`,
      ],
    });
    const agent = store.get(id)!;
    expect(agent).toMatchObject({ remoteHost: 'casita', sessionId: ID, directoryName: 'dev' });
    expect(agent.jsonlFile).toBe(mirrorPath('casita', ID));
    // Already open: a second press does nothing.
    expect(launchRemoteAgent(deps, casita, session, tail([]))).toBeNull();

    // The title records seed the label, with the host.
    await until(() => broadcasts.some((m) => m.type === 'agentSessionInfo'));
    expect(broadcasts.find((m) => m.type === 'agentSessionInfo')).toMatchObject({
      id,
      title: 'mos-884-outreach',
      color: 'red',
      host: 'casita',
      remoteKind: 'work',
    });
    // A record from the tail reaches the parser.
    await until(() => broadcasts.some((m) => m.type === 'agentToolStart'));
    expect(broadcasts.find((m) => m.type === 'agentToolStart')).toMatchObject({
      id,
      toolId: 'toolu_1',
    });

    // Closing the terminal: the character leaves, the copy goes.
    manager.dispose(id);
    await until(() => !store.has(id));
    expect(fs.existsSync(mirrorPath('casita', ID))).toBe(false);
  }, 10_000);

  it('attaches to a service and never resumes it; one outside tmux opens nothing', async () => {
    const deps = { store, runtime, ptyManager: manager, provider: claudeProvider };
    const service: RemoteSession = {
      ...session,
      title: 'svc-charalanda',
      labelLines: [rec({ type: 'custom-title', customTitle: 'svc-charalanda' })],
      tmux: 'charalanda-bot',
      live: { name: 'svc-charalanda', status: 'idle' },
      service: true,
    };
    expect(launchRemoteAgent(deps, casita, { ...service, tmux: undefined }, tail([]))).toBeNull();
    expect(spawned).toEqual([]);

    const id = launchRemoteAgent(deps, casita, service, tail([]))!;
    expect(spawned[0]).toEqual({
      file: 'ssh',
      args: ['-t', 'minipc', `tmux attach-session -t '=charalanda-bot'`],
    });
    expect(spawned[0].args.join(' ')).not.toContain('--resume');
    expect(store.get(id)).toMatchObject({ remoteHost: 'casita', remoteService: true });
    // The label: a service on its host.
    await until(() => broadcasts.some((m) => m.type === 'agentSessionInfo'));
    expect(broadcasts.find((m) => m.type === 'agentSessionInfo')).toMatchObject({
      id,
      title: 'svc-charalanda',
      host: 'casita',
      remoteKind: 'service',
    });

    manager.dispose(id);
    await until(() => !store.has(id));
  }, 10_000);
});
