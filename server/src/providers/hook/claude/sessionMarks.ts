import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../../../../core/src/isRecord.js';
import type { SessionMarks } from '../../../../../core/src/provider.js';
import { watchJsonFile, writeJsonAtomic } from '../../../jsonFileWatcher.js';
import {
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_PROJECTS_DIR_NAME,
  CONVERSATION_TITLE_SCAN_BYTES,
  NOT_A_PROMPT_ORIGINS,
  NOT_A_PROMPT_PREFIXES,
  SESSION_MARK_SCAN_MAX_BYTES,
  SESSION_MARKS_BY_OFFICE,
  SESSION_MARKS_FILE_NAME,
  SESSION_MARKS_INDEX_MAX_AGE_MS,
  SESSION_MARKS_VERSION,
} from './constants.js';

/**
 * Done marks: $CLAUDE_CONFIG_DIR/session-marks.json (else ~/.claude/), shared
 * with feature-flow and the `agent` CLI, which write it too:
 *
 *   { "version": 1, "marks": { "<sessionId>": { "done": "<ISO-8601>", "by": "office" } } }
 *
 * A key's presence marks its session done; removing the key unmarks it.
 * Fields this office doesn't know (in the file or in a mark) are kept. `done`
 * is written with milliseconds (a time rounded to the second can fall before
 * the prompt that asked for the mark, which would void it at once), the file
 * with a 2-space indent and a trailing newline, as the toolkit writes it. A
 * session with no transcript is never marked. Every
 * write is atomic (a temp file of its own, then a rename) and drops the marks
 * of sessions whose transcript (<config>/projects/x/<sessionId>.jsonl) is gone,
 * so the file shrinks as Claude Code's cleanupPeriodDays removes transcripts,
 * and the marks a user prompt has voided. A mark is void once the transcript
 * has a user prompt (not a tool result, not a local command) written after
 * its `done`. A missing or broken file reads as no marks.
 */

/** The config directory Claude Code uses: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(): string {
  return process.env[CLAUDE_CONFIG_DIR_ENV] || path.join(os.homedir(), '.claude');
}

export function sessionMarksPath(configDir: string): string {
  return path.join(configDir, SESSION_MARKS_FILE_NAME);
}

/** The file's content: the whole object (unknown fields kept) and its marks. */
export interface SessionMarksData {
  file: Record<string, unknown>;
  marks: Record<string, Record<string, unknown>>;
}

/** The file's text as marks; anything that isn't the format reads as none. */
export function parseSessionMarks(text: string | null): SessionMarksData {
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!isRecord(raw)) return { file: {}, marks: {} };
  const marks: Record<string, Record<string, unknown>> = {};
  if (isRecord(raw.marks)) {
    for (const [sessionId, mark] of Object.entries(raw.marks)) {
      if (isRecord(mark)) marks[sessionId] = mark;
    }
  }
  return { file: raw, marks };
}

function readSessionMarks(configDir: string): SessionMarksData {
  let text: string | null;
  try {
    text = fs.readFileSync(sessionMarksPath(configDir), 'utf-8');
  } catch {
    text = null;
  }
  return parseSessionMarks(text);
}

/** When a mark was made (ms), or undefined when its `done` is no timestamp. */
export function markTime(mark: Record<string, unknown>): number | undefined {
  if (typeof mark.done !== 'string') return undefined;
  const ms = Date.parse(mark.done);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether a transcript record is a prompt the user typed, by the same rule as
 * the toolkit's session-marks.py: a user record that is not meta text, a
 * compaction summary or a sidechain, not written for a background task's
 * notice or a peer session (`origin.kind`; a record with no origin counts),
 * not a tool result, and whose text does not start with one of
 * NOT_A_PROMPT_PREFIXES (a local command and its output, a notice, a system
 * reminder). `!cmd` (`<bash-input>`) is a prompt: the user typed it.
 */
export function isUserPrompt(record: unknown): boolean {
  if (!isRecord(record) || record.type !== 'user') return false;
  if (record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true) {
    return false;
  }
  if (isRecord(record.origin) && NOT_A_PROMPT_ORIGINS.includes(record.origin.kind as string)) {
    return false;
  }
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const blocks = content.filter(isRecord);
    if (blocks.some((block) => block.type === 'tool_result')) return false;
    const first = blocks.find((block) => block.type === 'text' && typeof block.text === 'string');
    text = (first?.text as string | undefined) ?? '';
  } else {
    return false;
  }
  const start = text.trimStart();
  return !NOT_A_PROMPT_PREFIXES.some((prefix) => start.startsWith(prefix));
}

/** When a record was written (ms), if it says. */
function recordTime(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined;
  const ms = Date.parse(record.timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether the user typed a prompt after `afterMs` in these records, read
 * newest first: true at the first such prompt, false at the first record
 * written at or before `afterMs` (nothing older can be after it). Undefined:
 * the lines ran out without deciding.
 */
export function promptAfterIn(
  linesNewestFirst: Iterable<string>,
  afterMs: number,
): boolean | undefined {
  for (const line of linesNewestFirst) {
    if (!line.includes('"timestamp"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    const at = recordTime(record);
    if (at === undefined) continue;
    if (at <= afterMs) return false;
    if (isUserPrompt(record)) return true;
  }
  return undefined;
}

/** A transcript's answers, by path, kept while its size and mtime hold. */
const promptCache = new Map<
  string,
  { size: number; mtimeMs: number; afterMs: number; found: boolean }
>();

/**
 * Whether the transcript has a user prompt written after `afterMs`: read from
 * its end backwards, a chunk at a time, until a record older than the mark
 * (no), such a prompt (yes), its start or SESSION_MARK_SCAN_MAX_BYTES (no: the
 * mark holds). A transcript last written before the mark is not read at all.
 */
export function userPromptAfter(
  transcript: string,
  afterMs: number,
  maxBytes = SESSION_MARK_SCAN_MAX_BYTES,
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcript);
  } catch {
    return false;
  }
  if (stat.mtimeMs <= afterMs) return false;
  const hit = promptCache.get(transcript);
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs && hit.afterMs === afterMs) {
    return hit.found;
  }
  const found = scanBackwards(transcript, stat.size, afterMs, maxBytes);
  promptCache.set(transcript, { size: stat.size, mtimeMs: stat.mtimeMs, afterMs, found });
  return found;
}

function scanBackwards(
  transcript: string,
  size: number,
  afterMs: number,
  maxBytes: number,
): boolean {
  let fd: number;
  try {
    fd = fs.openSync(transcript, 'r');
  } catch {
    return false;
  }
  try {
    let end = size;
    // The start of the earliest line read so far, cut by the chunk's edge.
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < maxBytes) {
      const start = Math.max(0, end - CONVERSATION_TITLE_SCAN_BYTES);
      const chunk = Buffer.alloc(end - start);
      const read = fs.readSync(fd, chunk, 0, chunk.length, start);
      let buf = Buffer.concat([chunk.subarray(0, read), carry]);
      if (start > 0) {
        const firstBreak = buf.indexOf(0x0a);
        if (firstBreak === -1) {
          carry = buf;
          end = start;
          continue;
        }
        carry = buf.subarray(0, firstBreak);
        buf = buf.subarray(firstBreak + 1);
      }
      const lines = buf.toString('utf8').split('\n').reverse();
      const answer = promptAfterIn(lines, afterMs);
      if (answer !== undefined) return answer;
      end = start;
    }
    return false;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Every top-level transcript under <config>/projects, by session id. */
export function transcriptIndex(configDir: string): Map<string, string> {
  const index = new Map<string, string>();
  const root = path.join(configDir, CLAUDE_PROJECTS_DIR_NAME);
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return index;
  }
  for (const project of projects) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, project));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.jsonl')) {
        index.set(name.slice(0, -'.jsonl'.length), path.join(root, project, name));
      }
    }
  }
  return index;
}

/** Whether a mark has been voided by a user prompt in its transcript. */
function voided(mark: Record<string, unknown>, transcript: string | undefined): boolean {
  const at = markTime(mark);
  return at !== undefined && transcript !== undefined && userPromptAfter(transcript, at);
}

/**
 * The marks after marking (`done`) or unmarking `sessionId`, pruned: a mark
 * whose transcript `index` doesn't hold is dropped, and so is one a user
 * prompt has voided. Unknown fields of a kept mark stay; a new mark keeps the
 * fields an older one of the same session had.
 */
export function nextMarks(
  marks: Readonly<Record<string, Record<string, unknown>>>,
  change: { sessionId: string; done: boolean; by: string; now: number },
  index: ReadonlyMap<string, string>,
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = {};
  for (const [sessionId, mark] of Object.entries(marks)) {
    if (sessionId === change.sessionId) continue;
    const transcript = index.get(sessionId);
    if (transcript === undefined || voided(mark, transcript)) continue;
    next[sessionId] = mark;
  }
  if (change.done && index.has(change.sessionId)) {
    next[change.sessionId] = {
      ...marks[change.sessionId],
      done: new Date(change.now).toISOString(),
      by: change.by,
    };
  }
  return next;
}

/** Done marks over the files of the config directory `configDir()` names
 *  (read anew on each call, so a changed CLAUDE_CONFIG_DIR is followed). */
export function createSessionMarks(
  configDir: () => string = claudeConfigDir,
  now: () => number = Date.now,
): SessionMarks {
  // Session id → transcript, rebuilt when a session isn't in it and it is
  // older than SESSION_MARKS_INDEX_MAX_AGE_MS (or the directory changed).
  let index = new Map<string, string>();
  let indexDir = '';
  let indexedAt = 0;
  const transcriptOf = (dir: string, sessionId: string): string | undefined => {
    const known = indexDir === dir ? index.get(sessionId) : undefined;
    if (known && fs.existsSync(known)) return known;
    if (indexDir !== dir || now() - indexedAt >= SESSION_MARKS_INDEX_MAX_AGE_MS) {
      index = transcriptIndex(dir);
      indexDir = dir;
      indexedAt = now();
    }
    return index.get(sessionId);
  };

  return {
    doneSessions() {
      const dir = configDir();
      const done = new Map<string, number>();
      for (const [sessionId, mark] of Object.entries(readSessionMarks(dir).marks)) {
        const at = markTime(mark);
        if (at === undefined || voided(mark, transcriptOf(dir, sessionId))) continue;
        done.set(sessionId, at);
      }
      return done;
    },

    setDone(sessionId, done) {
      const dir = configDir();
      const { file, marks } = readSessionMarks(dir);
      if (typeof file.version === 'number' && file.version > SESSION_MARKS_VERSION) {
        throw new Error(
          `${SESSION_MARKS_FILE_NAME} is version ${file.version}, newer than this office`,
        );
      }
      // A fresh index: pruning must not drop a mark on an old answer.
      index = transcriptIndex(dir);
      indexDir = dir;
      indexedAt = now();
      // The next prune would drop it anyway (and the toolkit refuses it too).
      if (done && !index.has(sessionId)) {
        throw new Error(`session ${sessionId} has no transcript to mark`);
      }
      const next = nextMarks(
        marks,
        { sessionId, done, by: SESSION_MARKS_BY_OFFICE, now: now() },
        index,
      );
      writeJsonAtomic(
        sessionMarksPath(dir),
        { ...file, version: file.version ?? SESSION_MARKS_VERSION, marks: next },
        { uniqueTmp: true, trailingNewline: true },
      );
    },

    watch(onChange) {
      const watcher = watchJsonFile(sessionMarksPath(configDir()), 'session marks', () =>
        onChange(),
      );
      return () => watcher.dispose();
    },
  };
}

/** The office's done marks for Claude Code. */
export const claudeSessionMarks = createSessionMarks();
