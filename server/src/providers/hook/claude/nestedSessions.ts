import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import { TRANSCRIPT_CWD_SCAN_BYTES } from './constants.js';

/**
 * Sessions filed under a folder below a Directory.
 *
 * Claude Code files a session under ~/.claude/projects/<key>, the key being the
 * path it runs in with every character but a letter, digit or `-` as `-`. A
 * session that changes its working directory (EnterWorktree moves it into
 * `<repo>/.claude/worktrees/<name>`, a `cd` into a subrepo does the same) has
 * its transcript moved to the new folder's key, so it is no longer under the
 * Directory it started in. The key is lossy (`/`, `.` and `_` all read `-`),
 * so the folders under a Directory are told by the encoded prefix alone: every
 * project folder whose name is the Directory's own folder name followed by
 * `-`. The real path comes from the transcript (transcriptCwd).
 */

/**
 * The project folders filed under folders below the ones in `ownDirs` (a
 * Directory's own session dirs, getSessionDirs): in the same projects root,
 * named like one of them followed by `-`. Missing roots give none.
 */
export function nestedSessionDirs(ownDirs: readonly string[]): string[] {
  const nested = new Set<string>();
  const own = new Set(ownDirs.map(foldName));
  for (const ownDir of ownDirs) {
    const root = path.dirname(ownDir);
    const prefix = foldName(ownDir) + '-';
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = foldName(entry.name);
      if (!entry.isDirectory() || !name.startsWith(prefix) || own.has(name)) continue;
      nested.add(path.join(root, entry.name));
    }
  }
  return [...nested];
}

/**
 * The working directory a transcript's session runs in, as the transcript
 * records it: a `cwd` whose key is the folder the transcript is filed under.
 * A session that moved records the folder it started in first and its new
 * one after the move, so the tail is read first, then the head. Undefined
 * when neither holds one (the caller falls back to the folder's name).
 */
export function transcriptCwd(transcriptPath: string): string | undefined {
  const key = foldName(path.basename(path.dirname(transcriptPath)));
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tail = cwdsIn(readChunk(fd, Math.max(0, size - TRANSCRIPT_CWD_SCAN_BYTES), size));
    const late = tail.reverse().find((cwd) => foldName(normalizeProjectPath(cwd)) === key);
    if (late !== undefined || size <= TRANSCRIPT_CWD_SCAN_BYTES) return late;
    return cwdsIn(readChunk(fd, 0, TRANSCRIPT_CWD_SCAN_BYTES)).find(
      (cwd) => foldName(normalizeProjectPath(cwd)) === key,
    );
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Every `"cwd":"…"` string field in a chunk of JSONL, in order (a field cut
 *  by the chunk's edge fails to parse and is skipped). Claude Code writes
 *  compact JSON; spaces around the colon are allowed all the same. */
function cwdsIn(chunk: string): string[] {
  const cwds: string[] = [];
  for (const match of chunk.matchAll(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      const cwd: unknown = JSON.parse(match[1]);
      if (typeof cwd === 'string' && cwd) cwds.push(cwd);
    } catch {
      // Cut or malformed: skip it.
    }
  }
  return cwds;
}

function readChunk(fd: number, start: number, end: number): string {
  const buf = Buffer.alloc(end - start);
  const read = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.toString('utf8', 0, read);
}

/** A folder name as compared: case-folded on Windows, where the drive letter's
 *  case differs between spellings of one path (see sessionDirOf). */
function foldName(name: string): string {
  const base = path.basename(name);
  return process.platform === 'win32' ? base.toLowerCase() : base;
}
