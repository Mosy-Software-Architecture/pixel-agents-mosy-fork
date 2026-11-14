import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  parseRemoteListing,
  REMOTE_LISTING_SCRIPT,
} from '../src/providers/hook/claude/remoteListing.js';

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
  watcher: '9d1f2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b',
  pastSvc: '2b1c0d9e-8f7a-4b6c-9d5e-3f2a1b0c9d8e',
  loneSvc: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d',
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
    // Services: named svc-<service> by the launcher; tmux keeps its own name.
    { sessionId: ID.bot, name: 'svc-charalanda', status: 'idle', tmux: 'charalanda-bot:@10.%10' },
    { sessionId: ID.tg, name: 'svc-casita-ha', status: 'busy', tmux: 'claude-tg-ha:@1.%1' },
    // A service running outside tmux (its supervisor runs it directly).
    { sessionId: ID.loneSvc, name: 'svc-axiom-alerts', status: 'idle', tmux: null },
    // Work whose names have the words the old filter dropped (bot, watch).
    {
      sessionId: ID.watcher,
      name: 'futmondo-bot-watch',
      status: 'idle',
      tmux: 'futmondo-agent:@3.%3',
    },
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
    // Services: by registry name, whatever their transcript's title.
    transcript(ID.bot, { mtime: 9_000, labels: [rec({ type: 'ai-title', aiTitle: 'Fichaje' })] }),
    transcript(ID.tg, { mtime: 8_000, labels: [rec({ type: 'ai-title', aiTitle: 'HA' })] }),
    transcript(ID.loneSvc, { mtime: 7_000 }),
    transcript(ID.watcher, { mtime: 6_000 }),
    // A service no longer running: by its transcript's title, and left out.
    transcript(ID.pastSvc, {
      mtime: 6_500,
      labels: [rec({ type: 'custom-title', customTitle: 'svc-charalanda' })],
    }),
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
  tmux: [
    'lead-casita',
    'mos-884-outreach',
    'charalanda-bot',
    'claude-tg-ha',
    'futmondo-agent',
    'dashboard',
  ],
};

describe('a remote host listing', () => {
  const sessions = parseRemoteListing(JSON.stringify(listing))!;
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  it('lists running sessions, titled past ones and running services, newest first', () => {
    expect(sessions.map((s) => s.sessionId)).toEqual([
      ID.bot,
      ID.tg,
      ID.loneSvc,
      ID.watcher,
      ID.lead,
      ID.outreach,
      ID.past,
    ]);
  });

  it('tells services by their svc- registry name, not by words in their names', () => {
    const services = sessions.filter((s) => s.service).map((s) => s.sessionId);
    expect(services).toEqual([ID.bot, ID.tg, ID.loneSvc]);
    expect(byId.get(ID.bot)).toMatchObject({ title: 'Fichaje', tmux: 'charalanda-bot' });
    expect(byId.get(ID.loneSvc)?.tmux).toBeUndefined();
    // "bot" and "watch" in a work session's names no longer hide it.
    expect(byId.get(ID.watcher)).toMatchObject({ tmux: 'futmondo-agent' });
    expect(byId.get(ID.watcher)?.service).toBeUndefined();
  });

  it("falls back to the transcript's title for a service with no registry name", () => {
    const nameless = parseRemoteListing(
      JSON.stringify({
        ...listing,
        live: [{ sessionId: ID.pastSvc, status: 'idle', tmux: 'charalanda-bot:@10.%10' }],
      }),
    )!;
    expect(nameless.find((s) => s.sessionId === ID.pastSvc)).toMatchObject({
      service: true,
      title: 'svc-charalanda',
    });
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

function hasPython(): boolean {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPython())('the listing script', () => {
  it('lists a running session that has not written its transcript yet', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-listing-'));
    try {
      fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', 'sessions', `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: ID.bot,
          name: 'svc-charalanda',
          status: 'idle',
          cwd: '/home/u/charalanda.bot',
          entrypoint: 'cli',
          startedAt: 1_234,
        }),
      );
      const out = execFileSync('python3', ['-'], {
        input: REMOTE_LISTING_SCRIPT,
        env: { ...process.env, HOME: home },
      }).toString();
      expect(parseRemoteListing(out)).toEqual([
        expect.objectContaining({
          sessionId: ID.bot,
          service: true,
          title: 'svc-charalanda',
          updatedAt: 1_234,
          transcript: path.join(
            home,
            '.claude',
            'projects',
            '-home-u-charalanda-bot',
            `${ID.bot}.jsonl`,
          ),
        }),
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads the host's done marks in the same call, voided by a later prompt", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-listing-'));
    const ids = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2'];
    try {
      const project = path.join(home, '.claude', 'projects', '-r');
      fs.mkdirSync(project, { recursive: true });
      const record = (type: string, content: unknown, timestamp: string) =>
        JSON.stringify({ type, cwd: '/r', entrypoint: 'cli', message: { content }, timestamp });
      const title = (n: number) => JSON.stringify({ type: 'ai-title', aiTitle: `T${n}` });
      fs.writeFileSync(
        path.join(project, `${ids[0]}.jsonl`),
        [record('user', 'build', '2026-11-12T09:00:00Z'), title(1)].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(project, `${ids[1]}.jsonl`),
        [
          record('user', 'build', '2026-11-12T09:00:00Z'),
          title(2),
          record('user', 'one more thing', '2026-11-12T11:00:00Z'),
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(home, '.claude', 'session-marks.json'),
        JSON.stringify({
          version: 1,
          marks: Object.fromEntries(
            ids.map((id) => [id, { done: '2026-11-12T10:00:00Z', by: 'cli' }]),
          ),
        }),
      );
      const out = execFileSync('python3', ['-'], {
        input: REMOTE_LISTING_SCRIPT,
        env: { ...process.env, HOME: home },
      }).toString();
      const done = new Map(parseRemoteListing(out)!.map((s) => [s.sessionId, s.done]));
      expect(done.get(ids[0])).toBe(true);
      expect(done.get(ids[1])).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
