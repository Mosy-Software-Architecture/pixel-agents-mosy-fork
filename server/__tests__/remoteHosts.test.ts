import { afterEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { parseRemoteHosts, type RemoteHost } from '../src/configPersistence.js';
import type { RemoteSession } from '../src/providers/hook/claude/remoteListing.js';
import {
  clearRemoteListings,
  refreshRemoteHosts,
  remoteAttachArgs,
  remoteCanOpen,
  remoteHostConversations,
  remoteSessionOf,
  remoteTailArgs,
  shellQuote,
  tmuxSessionName,
} from '../src/remoteHosts.js';

const casita: RemoteHost = { name: 'casita', ssh: 'minipc' };
const ID = '5c849872-d975-4bda-8c86-64d926e54fa6';

function session(extra: Partial<RemoteSession> = {}): RemoteSession {
  return {
    sessionId: ID,
    transcript: '/home/u/.claude/projects/-home-u-dev/x.jsonl',
    cwd: '/home/u/dev',
    updatedAt: 1_000,
    title: 'Outreach',
    labelLines: [],
    ...extra,
  };
}

/** The listing script's output for `sessions`, as remoteHosts reads it. */
function output(sessions: Array<Record<string, unknown>>, live: unknown[] = []): string {
  return JSON.stringify({ live, transcripts: sessions, tmux: ['mos-884'] });
}

describe('remote hosts in config.json', () => {
  it('keeps well-formed hosts and drops anything ssh could read as an option', () => {
    expect(
      parseRemoteHosts([
        { name: 'casita', ssh: 'minipc' },
        { name: 'casita', ssh: 'other' },
        { name: 'evil', ssh: '-oProxyCommand=touch /tmp/x' },
        { name: 'a b', ssh: 'x' },
        { name: 'vps', ssh: 'moises@vps.example.com' },
        'casita',
      ]),
    ).toEqual([
      { name: 'casita', ssh: 'minipc' },
      { name: 'vps', ssh: 'moises@vps.example.com' },
    ]);
    expect(parseRemoteHosts(undefined)).toEqual([]);
  });
});

describe('the commands run over ssh', () => {
  it('quotes a word for a POSIX shell, single quotes included', () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });

  it('attaches to the tmux session the session runs in', () => {
    expect(remoteAttachArgs(casita, session({ tmux: 'mos-884-outreach' }))).toEqual([
      '-t',
      'minipc',
      `tmux new-session -A -s 'mos-884-outreach' -c '/home/u/dev' 'claude --resume ${ID}'`,
    ]);
  });

  it('only attaches to a service, exactly by its tmux name, never resuming it', () => {
    const svc = session({ service: true, tmux: 'charalanda-bot', live: { name: 'svc-x' } });
    expect(remoteAttachArgs(casita, svc)).toEqual([
      '-t',
      'minipc',
      `tmux attach-session -t '=charalanda-bot'`,
    ]);
    expect(remoteCanOpen(svc)).toBe(true);
    // Outside tmux: nothing to attach to, and it is never resumed.
    expect(remoteCanOpen(session({ service: true, live: { name: 'svc-x' } }))).toBe(false);
    expect(remoteCanOpen(session())).toBe(true);
  });

  it('names a new tmux session after the session, never like another one', () => {
    expect(tmuxSessionName(session({ title: "Brief MOS-813: con Moisés's plan" }))).toBe(
      'brief-mos-813-con-mois-s-5c849872',
    );
    expect(tmuxSessionName(session({ title: 'x', live: { name: 'workspace-f1' } }))).toBe(
      'workspace-f1-5c849872',
    );
    expect(tmuxSessionName(session({ title: '¿?' }))).toBe('5c849872');
  });

  it('quotes a directory the shell would split or expand', () => {
    const [, , command] = remoteAttachArgs(casita, session({ cwd: "/home/u/it's $HOME" }));
    expect(command).toContain(`-c '/home/u/it'\\''s $HOME'`);
  });

  it('tails the transcript until the local ssh goes', () => {
    expect(remoteTailArgs(casita, '/home/u/a b.jsonl')).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=6',
      'minipc',
      `tail -n 0 -F '/home/u/a b.jsonl' & t=$!; cat >/dev/null; kill $t`,
    ]);
  });
});

describe('the remote listing cache', () => {
  afterEach(() => clearRemoteListings());

  const row = {
    sessionId: ID,
    path: '/r/x.jsonl',
    mtime: 1_000,
    cwd: '/home/u/dev',
    labels: [JSON.stringify({ type: 'ai-title', aiTitle: 'Outreach' })],
  };

  it('lists a host only once it has answered, offline when ssh failed', async () => {
    const store = new AgentStateStore();
    const vps: RemoteHost = { name: 'vps', ssh: 'vps' };
    expect(remoteHostConversations([casita, vps], store)).toEqual([]);
    await refreshRemoteHosts([casita, vps], 0, async (host) =>
      host === casita ? output([row]) : null,
    );
    expect(remoteHostConversations([casita, vps], store)).toEqual([
      {
        name: 'casita',
        online: true,
        conversations: [
          {
            sessionId: ID,
            title: 'Outreach',
            updatedAt: 1_000,
            agentId: undefined,
            palette: undefined,
            repeat: undefined,
            remoteKind: 'work',
          },
        ],
      },
      { name: 'vps', online: false, conversations: [] },
    ]);
  });

  it('asks again only once the listing is old enough', async () => {
    const asked: string[] = [];
    const run = async (host: RemoteHost) => {
      asked.push(host.name);
      return output([]);
    };
    await refreshRemoteHosts([casita], 60_000, run);
    expect(refreshRemoteHosts([casita], 60_000, run)).toBeNull();
    await refreshRemoteHosts([casita], 0, run);
    expect(asked).toEqual(['casita', 'casita']);
  });

  it('marks running sessions, the agent open on one, and one it can only resume', async () => {
    const live = [
      { sessionId: ID, name: 'mos-884', status: 'busy', tmux: 'mos-884:@1.%1' },
      { sessionId: '3f7555c7-b51c-4343-8111-d5bcf2cdc82a', name: 'loose', status: 'idle' },
    ];
    const other = { ...row, sessionId: '3f7555c7-b51c-4343-8111-d5bcf2cdc82a', mtime: 500 };
    await refreshRemoteHosts([casita], 0, async () => output([row, other], live));
    const store = new AgentStateStore();
    store.set(
      7,
      createAgentState({
        id: 7,
        sessionId: ID,
        projectDir: '/m',
        jsonlFile: '/m/x.jsonl',
        isExternal: false,
        remoteHost: 'casita',
        palette: 2,
      }),
    );
    const [host] = remoteHostConversations([casita], store);
    expect(host.conversations[0]).toMatchObject({ agentId: 7, palette: 2, remoteStatus: 'busy' });
    expect(host.conversations[0].liveElsewhere).toBeUndefined();
    // Running outside tmux: opening it resumes it, so the row asks first.
    expect(host.conversations[1]).toMatchObject({
      remoteStatus: 'idle',
      liveElsewhere: { name: 'loose', status: 'idle' },
    });
    expect(host.conversations[1].remoteKind).toBe('work');
    expect(remoteSessionOf([casita], 'casita', ID)?.session.tmux).toBe('mos-884');
    expect(remoteSessionOf([casita], 'vps', ID)).toBeUndefined();
    expect(remoteSessionOf([casita], 'casita', 'nope')).toBeUndefined();
  });

  it('sends every work session of the listing: the sidebar pages them', async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      ...row,
      sessionId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      mtime: 1_000 + i,
    }));
    await refreshRemoteHosts([casita], 0, async () => output(rows));
    const [host] = remoteHostConversations([casita], new AgentStateStore());
    expect(host.conversations).toHaveLength(14);
    // Newest first.
    expect(host.conversations[0].sessionId).toBe(rows[13].sessionId);
  });

  it('lists services after the work sessions, kind on each row', async () => {
    const svcId = '000427f6-24f4-456d-99f9-4812b0870168';
    const loneId = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
    const live = [
      { sessionId: svcId, name: 'svc-charalanda', status: 'idle', tmux: 'mos-884:@1.%1' },
      { sessionId: loneId, name: 'svc-axiom-alerts', status: 'idle' },
    ];
    const svc = { ...row, sessionId: svcId, mtime: 9_000 };
    const lone = { ...row, sessionId: loneId, mtime: 8_000 };
    await refreshRemoteHosts([casita], 0, async () => output([svc, lone, row], live));
    const [host] = remoteHostConversations([casita], new AgentStateStore());
    expect(host.conversations.map((c) => [c.sessionId, c.remoteKind])).toEqual([
      [ID, 'work'],
      [svcId, 'service'],
      [loneId, 'service'],
    ]);
    // Outside tmux: the row says so (and the webview won't open it).
    expect(host.conversations[2].liveElsewhere).toEqual({
      name: 'svc-axiom-alerts',
      status: 'idle',
    });
  });
});
