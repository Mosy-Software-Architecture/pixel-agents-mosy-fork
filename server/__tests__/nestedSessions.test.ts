import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Directory } from '../../core/src/messages.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import type { HookProvider } from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  findTranscript,
  listConversations,
  resumeRequest,
  searchConversations,
} from '../src/conversations.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { TRANSCRIPT_CWD_SCAN_BYTES } from '../src/providers/hook/claude/constants.js';
import { nestedSessionDirs, transcriptCwd } from '../src/providers/hook/claude/nestedSessions.js';

/**
 * Sessions filed below a Directory: Claude Code files a session under the
 * folder it runs in, so one that moved into a worktree or a subrepo has its
 * transcript filed under that folder's key. The sidebar lists it under the
 * Directory it started in, by the key's prefix, with where it runs.
 */

const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NO_LIVE = new Map();

describe('sessions filed below a Directory', () => {
  let base: string;
  let root: string;
  let web: Directory;

  /** Where the provider files a path's sessions: the projects root, keyed. */
  const ownDir = (p: string) => path.join(root, normalizeProjectPath(p));
  /** Claude's provider, its projects root moved into the test's temp dir. */
  const provider = (): HookProvider => ({
    ...claudeProvider,
    getSessionDirs: (p) => [ownDir(p)],
    getNestedSessionDirs: (p) => nestedSessionDirs([ownDir(p)]),
  });

  /** A transcript of `sessionId` filed as a session running in `cwd`, its
   *  records naming `recorded` (the folders it ran in, in order). */
  function transcript(
    cwd: string,
    sessionId: string,
    { title, recorded = [cwd], mtime }: { title: string; recorded?: string[]; mtime: number },
  ): string {
    const folder = ownDir(cwd);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${sessionId}.jsonl`);
    fs.writeFileSync(
      file,
      recorded.map((c) => line({ type: 'user', cwd: c, sessionId })).join('') +
        line({ type: 'ai-title', aiTitle: title }),
    );
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  }

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-nested-')));
    root = path.join(base, 'projects');
    fs.mkdirSync(root);
    web = { name: 'web', path: path.join(base, 'web'), source: 'user' };
    fs.mkdirSync(web.path);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('nestedSessionDirs', () => {
    it('finds the folders keyed like the own folder followed by -, never the own one', () => {
      for (const name of ['-w-web', '-w-web-app', '-w-web--claude-worktrees-x', '-w-webapp']) {
        fs.mkdirSync(path.join(root, name));
      }
      fs.writeFileSync(path.join(root, '-w-web-notes'), '');
      expect(nestedSessionDirs([path.join(root, '-w-web')]).sort()).toEqual([
        path.join(root, '-w-web--claude-worktrees-x'),
        path.join(root, '-w-web-app'),
      ]);
      expect(nestedSessionDirs([path.join(base, 'missing', '-w-web')])).toEqual([]);
    });
  });

  describe('transcriptCwd', () => {
    it('reads the working directory whose key is the folder the transcript is filed under', () => {
      const worktree = path.join(web.path, 'app', '.claude', 'worktrees', 'x');
      // It started in the Directory, moved to the repo, then to its worktree.
      const file = transcript(worktree, uuid(1), {
        title: 'Moved',
        recorded: [web.path, path.join(web.path, 'app'), worktree],
        mtime: 1_000,
      });
      expect(transcriptCwd(file)).toBe(worktree);
    });

    it('reads a cwd field written with spaces around its colon', () => {
      const app = path.join(web.path, 'app');
      const folder = ownDir(app);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${uuid(5)}.jsonl`);
      fs.writeFileSync(file, `{"type": "user", "cwd": ${JSON.stringify(app)}}\n`);
      expect(transcriptCwd(file)).toBe(app);
    });

    it('finds one in the head past a long tail, and none when no record names it', () => {
      const app = path.join(web.path, 'app');
      const file = transcript(app, uuid(2), { title: 'Long', mtime: 1_000 });
      fs.appendFileSync(
        file,
        line({ type: 'user', text: 'x'.repeat(TRANSCRIPT_CWD_SCAN_BYTES * 2) }),
      );
      expect(transcriptCwd(file)).toBe(app);

      const elsewhere = transcript(app, uuid(3), {
        title: 'Elsewhere',
        recorded: [web.path],
        mtime: 1_000,
      });
      expect(transcriptCwd(elsewhere)).toBeUndefined();
      expect(transcriptCwd(path.join(root, 'missing', `${uuid(4)}.jsonl`))).toBeUndefined();
    });
  });

  describe('the listing', () => {
    it('lists a session that moved below the Directory under it, with where it runs', () => {
      const worktree = path.join(web.path, 'app', '.claude', 'worktrees', 'x');
      transcript(web.path, uuid(1), { title: 'Here', mtime: 1_000 });
      transcript(worktree, uuid(2), {
        title: 'Moved',
        recorded: [web.path, worktree],
        mtime: 2_000,
      });
      const [listed] = listConversations([web], provider(), NO_LIVE);
      expect(listed.conversations.map((c) => [c.title, c.subpath])).toEqual([
        ['Moved', 'app/.claude/worktrees/x'],
        ['Here', undefined],
      ]);
    });

    it("falls back to the folder's name when the transcript names no working directory", () => {
      const folder = path.join(root, `${normalizeProjectPath(web.path)}-app--claude-worktrees-x`);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, `${uuid(1)}.jsonl`),
        line({ type: 'ai-title', aiTitle: 'Unknown' }),
      );
      const [listed] = listConversations([web], provider(), NO_LIVE);
      expect(listed.conversations.map((c) => c.subpath)).toEqual(['app--claude-worktrees-x']);
    });

    it('leaves out a folder that only looks below the Directory (the key is lossy)', () => {
      // /…/web-app files like a folder `app` below /…/web.
      transcript(path.join(base, 'web-app'), uuid(1), { title: 'Sibling', mtime: 1_000 });
      const [listed] = listConversations([web], provider(), NO_LIVE);
      expect(listed.conversations).toEqual([]);
    });

    it('lists a session filed in two folders once, from its newest copy', () => {
      const app = path.join(web.path, 'app');
      transcript(web.path, uuid(1), { title: 'Old copy', mtime: 1_000 });
      transcript(app, uuid(1), { title: 'Moved', recorded: [web.path, app], mtime: 2_000 });
      transcript(app, uuid(2), { title: 'Moved back', recorded: [app], mtime: 1_000 });
      transcript(web.path, uuid(2), { title: 'Back', mtime: 3_000 });
      const [listed] = listConversations([web], provider(), NO_LIVE);
      expect(listed.conversations.map((c) => [c.sessionId, c.title, c.subpath])).toEqual([
        [uuid(2), 'Back', undefined],
        [uuid(1), 'Moved', 'app'],
      ]);
    });

    it('prefers a titled copy over a newer untitled one, for the list and for a resume', () => {
      const app = path.join(web.path, 'app');
      fs.mkdirSync(app);
      const titled = transcript(app, uuid(1), {
        title: 'Moved',
        recorded: [web.path, app],
        mtime: 1_000,
      });
      // A process started in the Directory wrote a copy before any prompt.
      const stray = path.join(ownDir(web.path), `${uuid(1)}.jsonl`);
      fs.mkdirSync(path.dirname(stray), { recursive: true });
      fs.writeFileSync(stray, line({ type: 'mode', sessionId: uuid(1) }));
      fs.utimesSync(stray, 2, 2);
      const [listed] = listConversations([web], provider(), NO_LIVE);
      expect(listed.conversations.map((c) => [c.title, c.subpath])).toEqual([['Moved', 'app']]);
      expect(findTranscript(provider(), web.path, uuid(1))).toBe(titled);
    });

    it('gives a folder below two Directories, one inside the other, to the inner one only', () => {
      const appPath = path.join(web.path, 'app');
      fs.mkdirSync(appPath);
      const app: Directory = { name: 'app', path: appPath, source: 'user' };
      const worktree = path.join(appPath, '.claude', 'worktrees', 'x');
      transcript(appPath, uuid(1), { title: 'In app', mtime: 1_000 });
      transcript(worktree, uuid(2), { title: 'In its worktree', mtime: 2_000 });
      for (const order of [
        [web, app],
        [app, web],
      ]) {
        const listed = listConversations(order, provider(), NO_LIVE);
        const byPath = new Map(listed.map((d) => [d.path, d.conversations]));
        expect(byPath.get(web.path)).toEqual([]);
        expect(byPath.get(app.path)?.map((c) => [c.title, c.subpath])).toEqual([
          ['In its worktree', '.claude/worktrees/x'],
          ['In app', undefined],
        ]);
      }
    });

    it('caps, says there are more and counts done ones across both kinds of folder', () => {
      const app = path.join(web.path, 'app');
      for (let n = 1; n <= 7; n++) {
        transcript(n % 2 ? app : web.path, uuid(n), { title: `T${n}`, mtime: n * 1_000 });
      }
      const done = new Map([[uuid(7), 1]]);
      const [listed] = listConversations([web], provider(), NO_LIVE, new Map(), new Map(), done);
      expect(listed.conversations.map((c) => c.title)).toEqual(['T6', 'T5', 'T4', 'T3', 'T2']);
      expect(listed.more).toBe(true);
      expect(listed.doneHidden).toBe(1);
    });

    it('finds them in a search, under the Directory, with where they run', () => {
      const app = path.join(web.path, 'app');
      transcript(app, uuid(1), { title: 'Fix the parser', mtime: 1_000 });
      const found = searchConversations([web], provider(), NO_LIVE, {
        query: 'parser',
        directoryPath: web.path,
        limit: 10,
      });
      expect(found.results).toEqual([
        expect.objectContaining({
          directoryPath: web.path,
          conversation: expect.objectContaining({ title: 'Fix the parser', subpath: 'app' }),
        }),
      ]);
    });
  });

  describe('resuming', () => {
    it('resumes it from its newest transcript, where it runs', () => {
      const worktree = path.join(web.path, 'app', '.claude', 'worktrees', 'x');
      fs.mkdirSync(worktree, { recursive: true });
      transcript(web.path, uuid(1), { title: 'Old copy', mtime: 1_000 });
      const file = transcript(worktree, uuid(1), {
        title: 'Moved',
        recorded: [web.path, worktree],
        mtime: 2_000,
      });
      expect(findTranscript(provider(), web.path, uuid(1))).toBe(file);
      expect(
        resumeRequest(new AgentStateStore(), provider(), {
          sessionId: uuid(1),
          directoryPath: web.path,
        }),
      ).toMatchObject({ transcript: file, cwd: worktree });
    });

    it('resumes in the Directory a session filed under it, or one whose folder is gone', () => {
      transcript(web.path, uuid(1), { title: 'Here', mtime: 1_000 });
      const gone = path.join(web.path, 'removed-worktree');
      transcript(gone, uuid(2), { title: 'Gone', mtime: 1_000 });
      const store = new AgentStateStore();
      for (const sessionId of [uuid(1), uuid(2)]) {
        const resume = resumeRequest(store, provider(), { sessionId, directoryPath: web.path });
        expect(resume).not.toBeNull();
        expect(resume?.cwd).toBeUndefined();
      }
    });
  });
});
