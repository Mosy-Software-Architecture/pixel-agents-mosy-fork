import * as fs from 'fs';

import { isRecord } from '../../../../../core/src/isRecord.js';
import type { TranscriptSpan } from '../../../../../core/src/provider.js';
import { CLEAR_COMMAND_MARKER, TRANSCRIPT_SPAN_SCAN_BYTES } from './constants.js';

/**
 * When a session's transcript starts and ends, and whether it began with a
 * `/clear`: what the office needs to link a session cleared while it was not
 * running to the session that continues it (server/src/supersededSessions.ts).
 *
 * A `/clear` in Claude Code 2.1.325 leaves the old transcript as it was and
 * starts a new one whose first records are its title records (no timestamp),
 * then the `/clear` command itself as a user record. So the first timestamped
 * record of the new one is the moment of the clear, and the old one's last
 * timestamped record comes before it (trailing bookkeeping records carry no
 * timestamp). Only the file's head and tail are read
 * (TRANSCRIPT_SPAN_SCAN_BYTES each); a record cut by a window's edge fails to
 * parse and is skipped.
 */
export function transcriptSpan(transcriptPath: string): TranscriptSpan {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return {};
  }
  try {
    const size = fs.fstatSync(fd).size;
    const head = readChunk(fd, 0, Math.min(size, TRANSCRIPT_SPAN_SCAN_BYTES));
    const tail =
      size > TRANSCRIPT_SPAN_SCAN_BYTES
        ? readChunk(fd, size - TRANSCRIPT_SPAN_SCAN_BYTES, size)
        : head;
    const start = headFacts(head);
    const lastAt = lastTimestamp(tail);
    return {
      ...(start.firstAt !== undefined ? { firstAt: start.firstAt } : {}),
      ...(lastAt !== undefined ? { lastAt } : {}),
      ...(start.cleared ? { cleared: true } : {}),
    };
  } catch {
    return {};
  } finally {
    fs.closeSync(fd);
  }
}

/** The head's first timestamp, and whether a `/clear` command comes before
 *  the session's first model turn. */
function headFacts(chunk: string): { firstAt?: number; cleared: boolean } {
  let firstAt: number | undefined;
  let cleared = false;
  for (const line of chunk.split('\n')) {
    const record = parse(line);
    if (!record) continue;
    firstAt ??= timestampOf(record);
    if (record.type === 'assistant') break;
    if (record.type === 'user' && line.includes(CLEAR_COMMAND_MARKER)) cleared = true;
    if (cleared && firstAt !== undefined) break;
  }
  return { ...(firstAt !== undefined ? { firstAt } : {}), cleared };
}

/** The newest timestamp in a chunk (its records are in time order). */
function lastTimestamp(chunk: string): number | undefined {
  const lines = chunk.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parse(lines[i]);
    const at = record ? timestampOf(record) : undefined;
    if (at !== undefined) return at;
  }
  return undefined;
}

function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestampOf(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== 'string') return undefined;
  const at = Date.parse(record.timestamp);
  return Number.isFinite(at) ? at : undefined;
}

function readChunk(fd: number, start: number, end: number): string {
  const buf = Buffer.alloc(end - start);
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.toString('utf8', 0, read);
}
