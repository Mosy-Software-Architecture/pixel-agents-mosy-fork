import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Directory } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { listConversations, searchConversations } from '../src/conversations.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { parseRemoteListing } from '../src/providers/hook/claude/remoteListing.js';
import {
  createSessionMarks,
  isUserPrompt,
  nextMarks,
  parseSessionMarks,
  sessionMarksPath,
  transcriptIndex,
  userPromptAfter,
} from '../src/providers/hook/claude/sessionMarks.js';
import { agentSessionMarks, setSessionDone } from '../src/sessionMarks.js';
import {
  bashInput,
  compactSummary,
  localCommandCaveat,
  modelCommand,
  plainPrompt,
} from './fixtures/localCommandRecords.js';
import { finishedNotice } from './fixtures/taskNotifications.js';

/**
 * Done marks: $CLAUDE_CONFIG_DIR/session-marks.json, shared with feature-flow
 * and the `agent` CLI. Parsed tolerantly, pruned on every write (transcript
 * gone, mark voided), void once a user prompt follows the mark; the sidebar
 * leaves done conversations out of its lists, the search finds them.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DONE_AT = Date.parse('2026-11-12T10:00:00.000Z');
const at = (offsetMs: number) => new Date(DONE_AT + offsetMs).toISOString();

const userAt = (offsetMs: number, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: at(offsetMs),
    ...extra,
  });
const assistantAt = (offsetMs: number) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    timestamp: at(offsetMs),
  });

describe('isUserPrompt: what voids a mark, as the toolkit rules', () => {
  it('a prompt the user typed, as text or blocks, and `!cmd`', () => {
    expect(isUserPrompt(plainPrompt)).toBe(true);
    expect(isUserPrompt(JSON.parse(userAt(0, [{ type: 'text', text: 'again' }])))).toBe(true);
    expect(isUserPrompt(bashInput)).toBe(true);
    // No origin, or another kind of origin, still counts.
    expect(isUserPrompt(JSON.parse(userAt(0, 'hi', { origin: { kind: 'human' } })))).toBe(true);
  });

  it('not a tool result, a local command, a compaction, meta text, a notice or a peer', () => {
    expect(
      isUserPrompt(JSON.parse(userAt(0, [{ type: 'tool_result', tool_use_id: 't', content: '' }]))),
    ).toBe(false);
    for (const record of [modelCommand, compactSummary, localCommandCaveat]) {
      expect(isUserPrompt(record)).toBe(false);
    }
    for (const text of [
      '<local-command-stdout>x</local-command-stdout>',
      '<bash-stdout>x</bash-stdout>',
      '<bash-stderr>x</bash-stderr>',
      '<system-reminder>x</system-reminder>',
      finishedNotice('task-a'),
    ]) {
      expect(isUserPrompt(JSON.parse(userAt(0, text)))).toBe(false);
    }
    for (const kind of ['task-notification', 'peer']) {
      expect(isUserPrompt(JSON.parse(userAt(0, 'done!', { origin: { kind } })))).toBe(false);
    }
    expect(isUserPrompt(JSON.parse(userAt(0, 'hi', { isSidechain: true })))).toBe(false);
    expect(isUserPrompt(JSON.parse(userAt(0, 'hi', { isMeta: true })))).toBe(false);
    expect(isUserPrompt(JSON.parse(assistantAt(0)))).toBe(false);
  });
});

describe('parseSessionMarks', () => {
  it('keeps the file and its marks, unknown fields included', () => {
    const text = JSON.stringify({
      version: 1,
      note: 'x',
      marks: { [uuid(1)]: { done: at(0), by: 'cli', extra: 7 }, bad: 3 },
    });
    const { file, marks } = parseSessionMarks(text);
    expect(file.note).toBe('x');
    expect(marks).toEqual({ [uuid(1)]: { done: at(0), by: 'cli', extra: 7 } });
  });

  it('reads a missing or broken file as no marks', () => {
    expect(parseSessionMarks(null).marks).toEqual({});
    expect(parseSessionMarks('{ nope').marks).toEqual({});
    expect(parseSessionMarks('[]').marks).toEqual({});
    expect(parseSessionMarks('{"marks": 3}').marks).toEqual({});
  });
});

describe('the marks store', () => {
  let configDir: string;
  let projectDir: string;
  let clock: number;
  let marks: ReturnType<typeof createSessionMarks>;

  function transcript(sessionId: string, lines: string[], mtimeMs = Date.now()): string {
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
    fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    return file;
  }
  const readFile = () => JSON.parse(fs.readFileSync(sessionMarksPath(configDir), 'utf-8'));
  const writeFile = (value: unknown) =>
    fs.writeFileSync(sessionMarksPath(configDir), JSON.stringify(value));

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-marks-'));
    projectDir = path.join(configDir, 'projects', '-work-web');
    fs.mkdirSync(projectDir, { recursive: true });
    clock = DONE_AT;
    marks = createSessionMarks(
      () => configDir,
      () => clock,
    );
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('writes the shared format, atomically, with no temp file left', () => {
    transcript(uuid(1), [userAt(-1000, 'build it')]);
    marks.setDone(uuid(1), true);
    expect(readFile()).toEqual({
      version: 1,
      marks: { [uuid(1)]: { done: '2026-11-12T10:00:00.000Z', by: 'office' } },
    });
    expect(fs.readdirSync(configDir).filter((n) => n.includes('.tmp'))).toEqual([]);
    // 2-space indent and a trailing newline, as the toolkit writes it.
    expect(fs.readFileSync(sessionMarksPath(configDir), 'utf-8')).toMatch(
      /^\{\n  "version": 1,[^]*\}\n$/,
    );
    expect(marks.doneSessions()).toEqual(new Map([[uuid(1), DONE_AT]]));
    marks.setDone(uuid(1), false);
    expect(readFile().marks).toEqual({});
    expect(marks.doneSessions().size).toBe(0);
  });

  it('keeps unknown fields of the file and of a re-marked session', () => {
    transcript(uuid(1), [userAt(-1000, 'build it')]);
    writeFile({
      version: 1,
      owner: 'toolkit',
      marks: { [uuid(1)]: { done: at(-5), by: 'cli', ticket: 'MOS-1' } },
    });
    marks.setDone(uuid(1), true);
    expect(readFile()).toEqual({
      version: 1,
      owner: 'toolkit',
      marks: { [uuid(1)]: { done: at(0), by: 'office', ticket: 'MOS-1' } },
    });
  });

  it('prunes on every write the marks whose transcript is gone', () => {
    transcript(uuid(1), [userAt(-1000, 'one')]);
    transcript(uuid(2), [userAt(-1000, 'two')]);
    writeFile({
      version: 1,
      marks: { [uuid(3)]: { done: at(-1), by: 'cli' }, [uuid(2)]: { done: at(-1), by: 'cli' } },
    });
    marks.setDone(uuid(1), true);
    expect(Object.keys(readFile().marks).sort()).toEqual([uuid(1), uuid(2)]);
  });

  it('never marks a session with no transcript', () => {
    expect(() => marks.setDone(uuid(9), true)).toThrow(/no transcript/);
    expect(fs.existsSync(sessionMarksPath(configDir))).toBe(false);
  });

  it('refuses to rewrite a newer format', () => {
    transcript(uuid(1), [userAt(-1000, 'one')]);
    writeFile({ version: 2, marks: {} });
    expect(() => marks.setDone(uuid(1), true)).toThrow(/version 2/);
    expect(readFile().version).toBe(2);
  });

  it('a user prompt after the mark voids it; a tool result or a local command does not', () => {
    writeFile({ version: 1, marks: { [uuid(1)]: { done: at(0), by: 'feature-flow' } } });
    const file = transcript(
      uuid(1),
      [userAt(-2000, 'build it'), assistantAt(-1000), assistantAt(1000)],
      DONE_AT + 2000,
    );
    expect(marks.doneSessions().has(uuid(1))).toBe(true);
    fs.appendFileSync(
      file,
      [
        userAt(3000, [{ type: 'tool_result', tool_use_id: 't', content: 'x' }]),
        JSON.stringify(modelCommand).replace('2026-11-12T10:00:00.000Z', at(4000)),
      ].join('\n') + '\n',
    );
    fs.utimesSync(file, (DONE_AT + 5000) / 1000, (DONE_AT + 5000) / 1000);
    expect(marks.doneSessions().has(uuid(1))).toBe(true);
    fs.appendFileSync(file, userAt(6000, 'one more thing') + '\n');
    fs.utimesSync(file, (DONE_AT + 7000) / 1000, (DONE_AT + 7000) / 1000);
    expect(marks.doneSessions().has(uuid(1))).toBe(false);
    // The next write drops it from the file too.
    transcript(uuid(2), [userAt(-1000, 'two')]);
    marks.setDone(uuid(2), true);
    expect(Object.keys(readFile().marks)).toEqual([uuid(2)]);
  });

  it('a mark with no timestamp is no mark', () => {
    transcript(uuid(1), [userAt(-1000, 'one')]);
    writeFile({ version: 1, marks: { [uuid(1)]: { done: 'yesterday' } } });
    expect(marks.doneSessions().size).toBe(0);
  });

  it('finds a prompt across chunk edges, reading back from the end', () => {
    const filler = assistantAt(1000).replace('"ok"', `"${'x'.repeat(300 * 1024)}"`);
    const file = transcript(uuid(1), [userAt(-1000, 'build'), userAt(500, 'late prompt'), filler]);
    expect(userPromptAfter(file, DONE_AT)).toBe(true);
    // Capped: past the scan limit the mark holds.
    expect(userPromptAfter(file, DONE_AT - 1, 1024)).toBe(false);
  });

  it('indexes transcripts by session id under every project', () => {
    const other = path.join(configDir, 'projects', '-work-api');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, `${uuid(5)}.jsonl`), '');
    transcript(uuid(1), []);
    expect([...transcriptIndex(configDir).keys()].sort()).toEqual([uuid(1), uuid(5)]);
  });

  it('nextMarks drops what it must and stamps the new mark', () => {
    const index = new Map([[uuid(1), '/nowhere']]);
    expect(
      nextMarks(
        { [uuid(2)]: { done: at(0) } },
        { sessionId: uuid(1), done: true, by: 'office', now: DONE_AT },
        index,
      ),
    ).toEqual({ [uuid(1)]: { done: at(0), by: 'office' } });
  });
});

describe('done conversations in the sidebar', () => {
  let dir: string;
  let projectDir: string;
  const directory: Directory = { name: 'Web', path: '/work/web', source: 'user' };
  const provider = (): HookProvider => ({ ...claudeProvider, getSessionDirs: () => [projectDir] });

  function titled(n: number, mtime: number): void {
    const file = path.join(projectDir, `${uuid(n)}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: `Task ${n}` }) + '\n');
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-marks-list-'));
    projectDir = path.join(dir, 'sessions');
    fs.mkdirSync(projectDir);
    for (let n = 1; n <= 7; n++) titled(n, 1_700_000_000_000 + n * 1000);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves done ones out of the list, counted apart and not in the cap or `more`', () => {
    // Newest first: 7..1. 7 and 5 are done.
    const done = new Map([
      [uuid(7), 1],
      [uuid(5), 1],
    ]);
    const [listed] = listConversations(
      [directory],
      provider(),
      new Map(),
      new Map(),
      new Map(),
      done,
    );
    expect(listed.conversations.map((c) => c.title)).toEqual([
      'Task 6',
      'Task 4',
      'Task 3',
      'Task 2',
      'Task 1',
    ]);
    expect(listed.more).toBeUndefined();
    expect(listed.doneHidden).toBe(2);
    expect(listed.conversations.some((c) => c.done)).toBe(false);
  });

  it('a directory with only done ones lists none but says how many', () => {
    const done = new Map(Array.from({ length: 7 }, (_, i) => [uuid(i + 1), 1] as [string, number]));
    const [listed] = listConversations(
      [directory],
      provider(),
      new Map(),
      new Map(),
      new Map(),
      done,
    );
    expect(listed.conversations).toEqual([]);
    expect(listed.doneHidden).toBe(7);
  });

  it('the search finds done ones, flagged', () => {
    const done = new Map([[uuid(7), 1]]);
    const { results } = searchConversations(
      [directory],
      provider(),
      new Map(),
      { query: '', limit: 3 },
      new Map(),
      done,
    );
    expect(results.map((r) => [r.conversation.title, r.conversation.done])).toEqual([
      ['Task 7', true],
      ['Task 6', undefined],
      ['Task 5', undefined],
    ]);
  });
});

describe('agent marks and setSessionDone', () => {
  let configDir: string;
  let store: AgentStateStore;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-marks-agents-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'projects', 'p', `${uuid(1)}.jsonl`), '');
    store = new AgentStateStore();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('marks from the office, broadcasts, and the card map follows; sub-agents get none', () => {
    const agent = (id: number) =>
      createAgentState({
        id,
        sessionId: uuid(1),
        projectDir: '/p',
        jsonlFile: '/p/x.jsonl',
        isExternal: false,
      });
    store.set(1, agent(1));
    store.set(2, { ...agent(2), leadAgentId: 1 });
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    expect(agentSessionMarks(store, claudeProvider)).toEqual({ '1': { sessionId: uuid(1) } });
    setSessionDone(store, claudeProvider, { sessionId: uuid(1), done: true });
    expect(agentSessionMarks(store, claudeProvider)).toEqual({
      '1': { sessionId: uuid(1), done: true },
    });
    expect(sent.at(-1)).toMatchObject({ type: 'agentSessionMarks' });
    const file = JSON.parse(fs.readFileSync(path.join(configDir, 'session-marks.json'), 'utf-8'));
    expect(file.marks[uuid(1)].by).toBe('office');
  });

  it('ignores a malformed request', () => {
    setSessionDone(store, claudeProvider, { sessionId: '--flag', done: true });
    setSessionDone(store, claudeProvider, { sessionId: uuid(1), done: 'yes' });
    expect(fs.existsSync(path.join(configDir, 'session-marks.json'))).toBe(false);
  });
});

describe('remote marks', () => {
  it('a remote transcript carries its mark, void after a prompt in its tail', () => {
    const transcript = (n: number, userLines: string[]) => ({
      sessionId: uuid(n),
      path: `/r/${uuid(n)}.jsonl`,
      mtime: DONE_AT + 10_000,
      cwd: '/r',
      entrypoint: 'cli',
      labels: [JSON.stringify({ type: 'ai-title', aiTitle: `T${n}` })],
      done: at(0),
      userLines,
    });
    const sessions = parseRemoteListing(
      JSON.stringify({
        live: [],
        tmux: [],
        transcripts: [
          transcript(1, [userAt(-1000, 'build')]),
          transcript(2, [userAt(-1000, 'build'), userAt(5000, 'more please')]),
        ],
      }),
    );
    const byId = new Map(sessions!.map((s) => [s.sessionId, s.done]));
    expect(byId.get(uuid(1))).toBe(true);
    expect(byId.get(uuid(2))).toBeUndefined();
  });
});
