import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Directory } from '../../core/src/messages.js';
import type { HookProvider, LiveCliSession } from '../../core/src/provider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  listConversations,
  liveSessions,
  resumeRedirect,
  resumeRequest,
  searchConversations,
} from '../src/conversations.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { adoptExternalSessionFromHook } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { transcriptSpan } from '../src/providers/hook/claude/transcriptSpan.js';
import {
  applyInferredLinks,
  continueSession,
  inferSupersededLinks,
  keeperOf,
  parseSuperseded,
  registrySwitches,
  type SupersededMap,
  SupersededSessions,
  type TranscriptFacts,
  watchSupersededSessions,
} from '../src/supersededSessions.js';

/**
 * Superseded transcripts (MOS-947): Claude Code 2.1.325 fires no hook on
 * `/clear`, so the office sees it in the CLI's registry (the same pid names
 * another session) or, when it was not running, infers it from the
 * transcripts. The old transcript is then no agent and no row of its own.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (record: Record<string, unknown>) => JSON.stringify(record) + '\n';
const at = (iso: string) => new Date(iso).toISOString();

function memoryLinks(initial: SupersededMap = {}) {
  let saved: SupersededMap = initial;
  const links = new SupersededSessions({ load: () => saved, save: (l) => (saved = l) });
  return { links, saved: () => saved };
}

describe('parseSuperseded', () => {
  it('keeps links between session ids and drops anything else', () => {
    expect(
      parseSuperseded({
        [uuid(1)]: { sessionId: uuid(2), at: 5, inferred: true },
        [uuid(3)]: { sessionId: uuid(3) },
        [uuid(4)]: 'not a link',
        'not-a-session': { sessionId: uuid(5) },
        [uuid(6)]: { sessionId: '--flag' },
      }),
    ).toEqual({ [uuid(1)]: { sessionId: uuid(2), at: 5, inferred: true } });
    expect(parseSuperseded(null)).toEqual({});
  });
});

describe('SupersededSessions', () => {
  it('records a link, follows a chain to its newest session, and saves each change', () => {
    const { links, saved } = memoryLinks();
    expect(links.record(uuid(1), uuid(2), { at: 1 })).toBe(true);
    links.record(uuid(2), uuid(3), { at: 2, inferred: true });
    expect(links.successorOf(uuid(1))).toEqual({ sessionId: uuid(3), inferred: true });
    expect(links.isSuperseded(uuid(3))).toBe(false);
    expect(Object.keys(saved())).toEqual([uuid(1), uuid(2)]);
  });

  it('a session that runs again is not superseded: a /resume back makes no loop', () => {
    const { links } = memoryLinks();
    links.record(uuid(1), uuid(2));
    links.record(uuid(2), uuid(1));
    expect(links.isSuperseded(uuid(1))).toBe(false);
    expect(links.successorOf(uuid(2))).toEqual({ sessionId: uuid(1) });
  });

  it('an inference never replaces a link seen happen; a sighting confirms an inference', () => {
    const { links, saved } = memoryLinks();
    links.record(uuid(1), uuid(2));
    expect(links.record(uuid(1), uuid(3), { inferred: true })).toBe(false);
    expect(links.successorOf(uuid(1))).toEqual({ sessionId: uuid(2) });
    links.record(uuid(4), uuid(5), { inferred: true });
    links.record(uuid(4), uuid(5));
    expect(saved()[uuid(4)].inferred).toBeUndefined();
  });

  it('prunes the links whose transcripts are gone, on either side', () => {
    const { links } = memoryLinks();
    links.record(uuid(1), uuid(2));
    links.record(uuid(3), uuid(4));
    links.prune((id) => id !== uuid(4));
    expect(links.isSuperseded(uuid(1))).toBe(true);
    expect(links.isSuperseded(uuid(3))).toBe(false);
  });
});

describe('registrySwitches', () => {
  const entry = (pid: number, sessionId: string, startedAt?: number): LiveCliSession => ({
    pid,
    sessionId,
    ...(startedAt !== undefined ? { startedAt } : {}),
    cwd: '/work',
  });

  it('sees the same process name another session (a /clear)', () => {
    const first = registrySwitches(new Map(), [entry(60669, uuid(1), 100)]);
    expect(first.switches).toEqual([]);
    const second = registrySwitches(first.next, [entry(60669, uuid(2), 100)]);
    expect(second.switches).toEqual([{ pid: 60669, from: uuid(1), to: uuid(2), cwd: '/work' }]);
  });

  it('a new process, or a later one given the same pid, is no switch', () => {
    const first = registrySwitches(new Map(), [entry(1, uuid(1), 100)]);
    const second = registrySwitches(first.next, [entry(1, uuid(2), 200), entry(2, uuid(3), 300)]);
    expect(second.switches).toEqual([]);
  });
});

describe('inferSupersededLinks', () => {
  const folder = '/projects/-work';
  function facts(n: number, over: Partial<TranscriptFacts> = {}): TranscriptFacts {
    return {
      sessionId: uuid(n),
      path: `${folder}/${uuid(n)}.jsonl`,
      mtimeMs: n * 1000,
      title: 'lead',
      cwd: '/work',
      span: {},
      ...over,
    };
  }
  const old = facts(1, { span: { firstAt: 100, lastAt: 500 }, mtimeMs: 600 });
  const cleared = facts(2, { span: { firstAt: 700, lastAt: 900, cleared: true }, mtimeMs: 900 });

  it('links a session to the one a /clear started after it: same title, cwd and folder', () => {
    expect(inferSupersededLinks([old, cleared], new Set([uuid(2)]))).toEqual([
      { from: uuid(1), to: uuid(2) },
    ]);
    // Not running, but newer: still linked.
    expect(inferSupersededLinks([old, cleared], new Set())).toEqual([
      { from: uuid(1), to: uuid(2) },
    ]);
  });

  it('links nothing for another working directory, another title or another folder', () => {
    const live = new Set([uuid(2)]);
    expect(inferSupersededLinks([old, { ...cleared, cwd: '/elsewhere' }], live)).toEqual([]);
    expect(inferSupersededLinks([old, { ...cleared, title: 'other' }], live)).toEqual([]);
    expect(inferSupersededLinks([{ ...old, title: undefined }, cleared], live)).toEqual([]);
    expect(
      inferSupersededLinks([old, { ...cleared, path: `/projects/-else/${uuid(2)}.jsonl` }], live),
    ).toEqual([]);
  });

  it('links nothing while the old session still runs', () => {
    expect(inferSupersededLinks([old, cleared], new Set([uuid(1), uuid(2)]))).toEqual([]);
  });

  it('links nothing in the wrong order, or when the new one did not begin with a /clear', () => {
    const live = new Set([uuid(2)]);
    expect(
      inferSupersededLinks([old, { ...cleared, span: { ...cleared.span, firstAt: 400 } }], live),
    ).toEqual([]);
    expect(
      inferSupersededLinks([old, { ...cleared, span: { firstAt: 700, lastAt: 900 } }], live),
    ).toEqual([]);
  });

  it('links nothing when another session with that title was running at the /clear', () => {
    const rival = facts(3, { span: { firstAt: 200, lastAt: 1000 }, mtimeMs: 1000 });
    expect(inferSupersededLinks([old, cleared, rival], new Set([uuid(2)]))).toEqual([]);
  });

  it('takes the latest session before the /clear, once', () => {
    const older = facts(4, { span: { firstAt: 10, lastAt: 50 }, mtimeMs: 60 });
    expect(inferSupersededLinks([older, old, cleared], new Set([uuid(2)]))).toEqual([
      { from: uuid(1), to: uuid(2) },
    ]);
  });
});

describe('transcriptSpan (Claude)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-span-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the first and last timestamps, and a /clear at the start', () => {
    const file = path.join(dir, `${uuid(2)}.jsonl`);
    fs.writeFileSync(
      file,
      line({ type: 'custom-title', customTitle: 'lead', sessionId: uuid(2) }) +
        line({ type: 'user', isMeta: true, timestamp: at('2026-11-17T09:04:32Z') }) +
        line({
          type: 'user',
          message: { content: '<command-name>/clear</command-name>' },
          timestamp: at('2026-11-17T09:04:33Z'),
        }) +
        line({ type: 'assistant', timestamp: at('2026-11-17T09:05:00Z') }) +
        line({ type: 'cost-state' }),
    );
    expect(transcriptSpan(file)).toEqual({
      firstAt: Date.parse('2026-11-17T09:04:32Z'),
      lastAt: Date.parse('2026-11-17T09:05:00Z'),
      cleared: true,
    });
  });

  it('a /clear typed later in a session does not make it a cleared one', () => {
    const file = path.join(dir, `${uuid(3)}.jsonl`);
    fs.writeFileSync(
      file,
      line({ type: 'user', message: { content: 'hi' }, timestamp: at('2026-11-17T09:00:00Z') }) +
        line({ type: 'assistant', timestamp: at('2026-11-17T09:00:01Z') }) +
        line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    );
    expect(transcriptSpan(file).cleared).toBeUndefined();
  });
});

describe('the office and a /clear', () => {
  let dir: string;
  let projectDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let links: SupersededSessions;
  let live: LiveCliSession[];
  let provider: HookProvider;
  const directory: Directory = { name: 'Work', path: '/work', source: 'user' };

  function transcript(sessionId: string, records: Array<Record<string, unknown>>, mtime?: number) {
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, records.map(line).join(''));
    if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  }

  function agent(id: number, sessionId: string, over: Record<string, unknown> = {}) {
    const state = createAgentState({
      id,
      sessionId,
      isExternal: true,
      projectDir,
      jsonlFile: path.join(projectDir, `${sessionId}.jsonl`),
      palette: id,
      ...over,
    });
    store.set(id, state);
    runtime.registerAgent(sessionId, id);
    return state;
  }

  const deps = (terminals?: { has(id: number): boolean; dispose(id: number): void }) => ({
    store,
    runtime,
    provider,
    superseded: links,
    terminals,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-superseded-'));
    projectDir = path.join(dir, 'projects', '-work');
    fs.mkdirSync(projectDir, { recursive: true });
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    links = memoryLinks().links;
    runtime.superseded = links;
    live = [];
    provider = {
      ...claudeProvider,
      getSessionDirs: () => [projectDir],
      getNestedSessionDirs: () => [],
      getAllSessionRoots: () => [path.join(dir, 'projects')],
      liveSessions: () => live,
      registeredSessions: () => live,
      transcriptCwd: () => '/work',
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.dispose();
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a process that switches session moves its agent there and records the link', () => {
    vi.useFakeTimers();
    transcript(uuid(1), [{ type: 'custom-title', customTitle: 'lead' }]);
    const lead = agent(1, uuid(1));
    live = [{ pid: 60669, sessionId: uuid(1), startedAt: 1, cwd: '/work' }];
    const stop = watchSupersededSessions(deps(), () => {}, 100);

    transcript(uuid(2), [{ type: 'custom-title', customTitle: 'lead' }]);
    live = [{ pid: 60669, sessionId: uuid(2), startedAt: 1, cwd: '/work' }];
    vi.advanceTimersByTime(150);
    stop();

    expect(store.size).toBe(1);
    expect(lead).toMatchObject({ id: 1, sessionId: uuid(2), palette: 1 });
    expect(lead.jsonlFile).toBe(path.join(projectDir, `${uuid(2)}.jsonl`));
    expect(links.successorOf(uuid(1))).toEqual({ sessionId: uuid(2) });
    // Hooks for the new session reach the same agent.
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: uuid(2),
    });
    expect(lead.hookDelivered).toBe(true);
    expect(store.size).toBe(1);
  });

  it('a /clear seen through the hooks (older CLIs) records the link too', () => {
    const lead = agent(1, uuid(1));
    const next = transcript(uuid(2), [{ type: 'user' }]);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: uuid(1),
      reason: 'clear',
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: uuid(2),
      source: 'clear',
      transcript_path: next,
      cwd: '/work',
    });
    expect(lead.sessionId).toBe(uuid(2));
    expect(links.successorOf(uuid(1))).toEqual({ sessionId: uuid(2) });
  });

  it('the link is kept in the office state file (standalone-state.json)', () => {
    const adapter = new FileStateAdapter({ namespace: 'standalone' });
    const saved = new SupersededSessions({
      load: () => adapter.loadSuperseded(),
      save: (l) => adapter.saveSuperseded(l),
    });
    saved.record(uuid(1), uuid(2), { at: 7 });
    const again = new SupersededSessions({
      load: () => adapter.loadSuperseded(),
      save: (l) => adapter.saveSuperseded(l),
    });
    expect(again.successorOf(uuid(1))).toEqual({ sessionId: uuid(2) });
  });

  it('when another agent already runs the new session, the one with a terminal stays', () => {
    transcript(uuid(2), [{ type: 'user' }]);
    const old = agent(1, uuid(1));
    const adopted = agent(2, uuid(2));
    const disposed: number[] = [];
    continueSession(
      deps({ has: (id) => id === 1, dispose: (id) => disposed.push(id) }),
      uuid(1),
      uuid(2),
    );
    expect([...store.keys()]).toEqual([1]);
    expect(old.sessionId).toBe(uuid(2));
    expect(adopted.sessionId).toBe(uuid(2));
    expect(disposed).toEqual([]);
  });

  it('with no terminal on either, the older agent stays', () => {
    transcript(uuid(2), [{ type: 'user' }]);
    agent(5, uuid(1));
    agent(3, uuid(2));
    continueSession(deps(), uuid(1), uuid(2));
    expect([...store.keys()]).toEqual([3]);
    expect(keeperOf({ id: 4 }, { id: 2 })).toEqual({ id: 2 });
  });

  it('adoption skips a superseded session', () => {
    links.record(uuid(1), uuid(2));
    const file = transcript(uuid(1), [{ type: 'user' }]);
    adoptExternalSessionFromHook(
      uuid(1),
      file,
      '/work',
      new Set(),
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => {},
    );
    expect(store.size).toBe(0);
  });

  describe('a /clear the office did not see (it was not running)', () => {
    const t0 = Date.now() - 60 * 60 * 1000;
    function seed() {
      transcript(
        uuid(1),
        [
          { type: 'custom-title', customTitle: 'lead' },
          { type: 'user', message: { content: 'go' }, timestamp: at(new Date(t0).toISOString()) },
          { type: 'assistant', timestamp: at(new Date(t0 + 60_000).toISOString()) },
          { type: 'cost-state' },
        ],
        t0 + 70_000,
      );
      transcript(
        uuid(2),
        [
          { type: 'custom-title', customTitle: 'lead' },
          {
            type: 'user',
            message: { content: '<command-name>/clear</command-name>' },
            timestamp: at(new Date(t0 + 70_000).toISOString()),
          },
          { type: 'last-prompt', lastPrompt: 'next' },
        ],
        t0 + 80_000,
      );
    }

    it('is inferred: the old row leaves the lists, the search labels it', () => {
      seed();
      live = [{ pid: 60669, sessionId: uuid(2), name: 'lead', cwd: '/work' }];
      const files = fs.readdirSync(projectDir).map((name) => {
        const p = path.join(projectDir, name);
        const st = fs.statSync(p);
        return { path: p, size: st.size, mtimeMs: st.mtimeMs };
      });
      expect(applyInferredLinks(deps(), files)).toBe(true);
      expect(links.successorOf(uuid(1))).toEqual({ sessionId: uuid(2), inferred: true });

      const lead = agent(1, uuid(2));
      const [listed] = listConversations(
        [directory],
        provider,
        liveSessions(store),
        new Map(),
        new Map(),
        new Map(),
        links.successors(),
      );
      expect(listed.conversations.map((c) => c.sessionId)).toEqual([uuid(2)]);
      expect(listed.supersededHidden).toBe(1);

      const { results } = searchConversations(
        [directory],
        provider,
        liveSessions(store),
        { query: '', limit: 10 },
        new Map(),
        new Map(),
        links.successors(),
      );
      expect(results.find((r) => r.conversation.sessionId === uuid(1))?.conversation).toMatchObject(
        { superseded: { sessionId: uuid(2), agentId: lead.id, inferred: true } },
      );
    });

    it('an agent restored on the old session moves to the new one', () => {
      seed();
      const restored = agent(1, uuid(1));
      const files = fs.readdirSync(projectDir).map((name) => {
        const p = path.join(projectDir, name);
        const st = fs.statSync(p);
        return { path: p, size: st.size, mtimeMs: st.mtimeMs };
      });
      applyInferredLinks(deps(), files);
      expect(restored.sessionId).toBe(uuid(2));
    });
  });

  describe('resuming a conversation that continues elsewhere', () => {
    beforeEach(() => {
      transcript(uuid(1), [
        { type: 'custom-title', customTitle: 'lead' },
        { type: 'user', cwd: '/work' },
      ]);
    });
    const msg = { sessionId: uuid(1), directoryPath: '/work' };

    it('goes to the agent running its title under another id, and launches nothing', () => {
      live = [{ pid: 1, sessionId: uuid(2), name: 'lead', cwd: '/work' }];
      agent(7, uuid(2));
      expect(resumeRedirect(store, provider, msg)).toEqual({
        kind: 'agent',
        liveSessionId: uuid(2),
        agentId: 7,
      });
      expect(resumeRequest(store, provider, msg)).toBeNull();
    });

    it('attaches to it when it runs in the background', () => {
      live = [
        { pid: 1, sessionId: uuid(2), name: 'lead', kind: 'background', backgroundId: '00000000' },
      ];
      expect(resumeRedirect(store, provider, msg)).toMatchObject({
        kind: 'attach',
        liveSessionId: uuid(2),
        backgroundId: '00000000',
      });
    });

    it('says so when another terminal runs it', () => {
      live = [{ pid: 1, sessionId: uuid(2), name: 'lead' }];
      expect(resumeRedirect(store, provider, msg)).toEqual({
        kind: 'elsewhere',
        liveSessionId: uuid(2),
        name: 'lead',
      });
    });

    it('resumes as asked when nothing else carries its title, or in another directory', () => {
      live = [{ pid: 1, sessionId: uuid(2), name: 'other' }];
      expect(resumeRedirect(store, provider, msg)).toBeNull();
      live = [{ pid: 1, sessionId: uuid(2), name: 'lead', cwd: '/elsewhere' }];
      expect(resumeRedirect(store, provider, msg)).toBeNull();
      expect(resumeRequest(store, provider, msg)).not.toBeNull();
    });

    it('never resumes a superseded one', () => {
      links.record(uuid(1), uuid(2));
      expect(resumeRedirect(store, provider, msg, links)).toEqual({
        kind: 'none',
        liveSessionId: uuid(2),
      });
      expect(resumeRequest(store, provider, msg, links)).toBeNull();
    });
  });
});
