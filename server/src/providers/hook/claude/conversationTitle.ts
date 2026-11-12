import * as fs from 'fs';

import { isRecord } from '../../../../../core/src/isRecord.js';
import type { SessionInfo, SessionInfoRecord } from '../../../../../core/src/provider.js';
import {
  CLAUDE_DEFAULT_AGENT_COLOR,
  CONVERSATION_TITLE_MAX_CHARS,
  CONVERSATION_TITLE_SCAN_BYTES,
} from './constants.js';

/**
 * The title Claude Code shows for a session, read from its transcript.
 *
 * Claude Code appends title records as a session goes on, so the newest is
 * near the end: `custom-title` (the user's /rename, which wins), `ai-title`
 * (the one it generates) and `last-prompt` (the fallback for a session too
 * short to have been titled). Only the file's tail is read, then its head
 * (an early title of a session whose tail is one long tool result): a
 * transcript can run to many megabytes. So a /rename written mid-file, with
 * more than CONVERSATION_TITLE_SCAN_BYTES of records after it and before it,
 * is not seen: an older title shows instead.
 *
 * The two windows overlap for a file under twice the scan size; a record found
 * in both gives the same answer under the precedence below. A record cut by a
 * window's edge fails to parse and is skipped.
 */
export function conversationTitle(transcriptPath: string): string | undefined {
  const found = scanTranscript(transcriptPath);
  if (!found) return undefined;
  const title = found.custom ?? found.ai ?? found.prompt;
  return title ? clip(title) : undefined;
}

/**
 * The session's name, colour and agent setting, from the same scan as its
 * title: the newest `custom-title` (else `ai-title`; a last prompt is no
 * name), `agent-color` (/color) and `agent-setting` (--agent). Claude Code
 * appends these again and again as the session goes on, so the tail almost
 * always holds the current ones.
 */
export function sessionInfo(transcriptPath: string): SessionInfo {
  const found = scanTranscript(transcriptPath);
  if (!found) return {};
  const title = found.custom ?? found.ai;
  return {
    ...(title ? { title: clip(title) } : {}),
    ...(found.custom ? { titleIsUsers: true } : {}),
    ...(found.color ? { color: found.color } : {}),
    ...(found.agentSetting ? { agentSetting: found.agentSetting } : {}),
  };
}

/**
 * The title and colour a chunk of a transcript's records gives, as
 * conversationTitle and sessionInfo would read them: for a transcript on
 * another machine, whose title records arrive over ssh (remoteListing.ts).
 */
export function labelFromChunk(chunk: string): { title?: string; color?: string } {
  const found = foundIn(chunk);
  const title = found.custom ?? found.ai ?? found.prompt;
  return {
    ...(title ? { title: clip(title) } : {}),
    ...(found.color ? { color: found.color } : {}),
  };
}

/** A transcript record's news about its session, or null for any other record. */
export function sessionInfoFromRecord(record: unknown): SessionInfoRecord | null {
  if (!isRecord(record)) return null;
  switch (record.type) {
    case 'custom-title': {
      const title = text(record, 'customTitle');
      return title ? { kind: 'title', title: clip(title), byUser: true } : null;
    }
    case 'ai-title': {
      const title = text(record, 'aiTitle');
      return title ? { kind: 'title', title: clip(title), byUser: false } : null;
    }
    case 'agent-color':
      return { kind: 'color', color: colorName(record.agentColor) };
    case 'agent-setting':
      return { kind: 'agentSetting', agentSetting: text(record, 'agentSetting')?.trim() };
    default:
      return null;
  }
}

/** What one window of a transcript holds: the newest of each kind of record.
 *  `null` for a colour or agent setting: the window's newest one cleared it. */
interface Found {
  custom?: string;
  ai?: string;
  prompt?: string;
  color?: string | null;
  agentSetting?: string | null;
}

/** The tail's newest records, then the head's for what the tail lacks
 *  (null when the file can't be read). */
function scanTranscript(transcriptPath: string): Found | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const late = foundIn(readChunk(fd, Math.max(0, size - CONVERSATION_TITLE_SCAN_BYTES), size));
    // The tail's rename is the newest one and wins over anything in the head.
    const early =
      late.custom === undefined && size > CONVERSATION_TITLE_SCAN_BYTES
        ? foundIn(readChunk(fd, 0, CONVERSATION_TITLE_SCAN_BYTES))
        : {};
    return {
      custom: late.custom ?? early.custom,
      ai: late.ai ?? early.ai,
      prompt: late.prompt ?? early.prompt,
      // A colour cleared in the tail stays cleared: only a tail that says
      // nothing about it defers to the head.
      color: late.color !== undefined ? late.color : early.color,
      agentSetting: late.agentSetting !== undefined ? late.agentSetting : early.agentSetting,
    };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The newest record of each kind in a chunk of JSONL (a cut line at either
 *  end simply fails to parse). */
function foundIn(chunk: string): Found {
  const found: Found = {};
  for (const line of chunk.split('\n')) {
    if (!line.includes('title"') && !line.includes('"last-prompt"') && !line.includes('"agent-')) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.type === 'last-prompt') {
      found.prompt = text(parsed, 'lastPrompt') ?? found.prompt;
      continue;
    }
    const news = sessionInfoFromRecord(parsed);
    if (!news) continue;
    if (news.kind === 'title') {
      if (news.byUser) found.custom = news.title;
      else found.ai = news.title;
    } else if (news.kind === 'color') {
      found.color = news.color ?? null;
    } else {
      found.agentSetting = news.agentSetting ?? null;
    }
  }
  return found;
}

/** A record's non-blank string field. */
function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A /color name, lower case; undefined when the user reset it. */
function colorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim().toLowerCase();
  return name && name !== CLAUDE_DEFAULT_AGENT_COLOR ? name : undefined;
}

function readChunk(fd: number, start: number, end: number): string {
  const buf = Buffer.alloc(end - start);
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.toString('utf8', 0, read);
}

/** One line, at most CONVERSATION_TITLE_MAX_CHARS. */
function clip(title: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length > CONVERSATION_TITLE_MAX_CHARS
    ? `${line.slice(0, CONVERSATION_TITLE_MAX_CHARS - 1)}…`
    : line;
}
