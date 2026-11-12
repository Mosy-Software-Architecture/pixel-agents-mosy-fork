import { describe, expect, it } from 'vitest';

import { parseRemoteListing } from '../src/providers/hook/claude/remoteListing.js';

/**
 * What the remote listing script prints, read into the sessions a remote
 * host's sidebar section lists.
 */

const ID = {
  lead: '3f7555c7-b51c-4343-8111-d5bcf2cdc82a',
  outreach: '5c849872-d975-4bda-8c86-64d926e54fa6',
  bot: '000427f6-24f4-456d-99f9-4812b0870168',
  tg: 'ff39d700-5ac1-433c-af9f-8ecea3c4c09c',
  past: '798a28b2-68f4-4389-8418-9feed80362ba',
  untitled: 'dec6d67e-c925-4f47-a6e9-862ce14c4d55',
  print: '04439554-9856-4868-88c0-d1675f3e3f44',
};

const rec = (record: Record<string, unknown>) => JSON.stringify(record);

function transcript(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    path: `/home/u/.claude/projects/-home-u-dev/${sessionId}.jsonl`,
    mtime: 1_000,
    cwd: '/home/u/dev',
    entrypoint: 'cli',
    labels: [],
    ...extra,
  };
}

const listing = {
  live: [
    { sessionId: ID.lead, name: 'workspace-f1', status: 'busy', tmux: 'lead-casita:@6.%6' },
    { sessionId: ID.outreach, name: 'mos-884-outreach', status: 'idle', tmux: null },
    { sessionId: ID.bot, name: 'charalanda-19', status: 'idle', tmux: 'charalanda-bot:@10.%10' },
    { sessionId: ID.tg, name: 'casita-ha-8b', status: 'idle', tmux: 'claude-tg-ha:@1.%1' },
  ],
  transcripts: [
    // Running, untitled: titled with its registry name.
    transcript(ID.lead, { mtime: 5_000 }),
    // Running, renamed and coloured; no tmux field, but a tmux session of its name.
    transcript(ID.outreach, {
      mtime: 4_000,
      labels: [
        rec({ type: 'ai-title', aiTitle: 'Generated' }),
        rec({ type: 'custom-title', customTitle: 'mos-884-outreach' }),
        rec({ type: 'agent-color', agentColor: 'Red' }),
      ],
    }),
    // Bots: by registry name, by tmux session.
    transcript(ID.bot, { mtime: 9_000, labels: [rec({ type: 'ai-title', aiTitle: 'Fichaje' })] }),
    transcript(ID.tg, { mtime: 9_000, labels: [rec({ type: 'ai-title', aiTitle: 'HA' })] }),
    // Past, titled from its last prompt; past and untitled; a `claude -p` run.
    transcript(ID.past, {
      mtime: 2_000,
      cwd: '/home/u/futmondo bot',
      labels: [rec({ type: 'last-prompt', lastPrompt: 'Rutina REVISION.md' })],
    }),
    transcript(ID.untitled, { mtime: 3_000 }),
    transcript(ID.print, {
      entrypoint: 'sdk-cli',
      labels: [rec({ type: 'last-prompt', lastPrompt: 'x' })],
    }),
  ],
  tmux: ['lead-casita', 'mos-884-outreach', 'charalanda-bot', 'claude-tg-ha', 'dashboard'],
};

describe('a remote host listing', () => {
  const sessions = parseRemoteListing(JSON.stringify(listing))!;
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  it('lists running and titled past sessions, newest first, and nothing else', () => {
    expect(sessions.map((s) => s.sessionId)).toEqual([ID.lead, ID.outreach, ID.past]);
  });

  it('titles a running session with its registry name until the CLI titles it', () => {
    expect(byId.get(ID.lead)).toMatchObject({
      title: 'workspace-f1',
      live: { name: 'workspace-f1', status: 'busy' },
      tmux: 'lead-casita',
      cwd: '/home/u/dev',
      updatedAt: 5_000,
    });
  });

  it("reads the title and colour as a local transcript's, keeping the records for the copy", () => {
    const outreach = byId.get(ID.outreach)!;
    expect(outreach).toMatchObject({ title: 'mos-884-outreach', color: 'red' });
    expect(outreach.labelLines).toHaveLength(3);
    // No tmux field: the tmux session named like the session.
    expect(outreach.tmux).toBe('mos-884-outreach');
  });

  it('keeps a past session without live state or tmux', () => {
    const past = byId.get(ID.past)!;
    expect(past.title).toBe('Rutina REVISION.md');
    expect(past.live).toBeUndefined();
    expect(past.tmux).toBeUndefined();
  });

  it('only counts a tmux session the host lists', () => {
    const gone = parseRemoteListing(JSON.stringify({ ...listing, tmux: [] }))!;
    expect(gone.find((s) => s.sessionId === ID.lead)?.tmux).toBeUndefined();
  });

  it('refuses what is not the script output, and ids that are not UUIDs', () => {
    expect(parseRemoteListing('ssh: Could not resolve hostname')).toBeNull();
    expect(parseRemoteListing('{"live":[]}')).toBeNull();
    const odd = parseRemoteListing(
      JSON.stringify({
        transcripts: [transcript('--help', { labels: [rec({ type: 'ai-title', aiTitle: 't' })] })],
      }),
    );
    expect(odd).toEqual([]);
  });
});
