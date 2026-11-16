import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type {
  AgentLook,
  Conversation,
  Directory,
  DirectoryConversations,
  FoundConversation,
  LiveElsewhere,
} from '../../core/src/messages.js';
import type { HookProvider, LiveCliSession } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONVERSATION_LOOKS_MAX,
  CONVERSATION_QUERY_MAX_CHARS,
  CONVERSATIONS_FILE_NAME,
  CONVERSATIONS_LIMIT_ENTRIES_MAX,
  CONVERSATIONS_LIMIT_MAX,
  CONVERSATIONS_PER_DIRECTORY,
  NEW_CONVERSATION_TITLE,
  PIXEL_AGENTS_DIR,
} from './constants.js';
import { transcriptSuffix } from './directorySuggestions.js';
import { writeJsonAtomic } from './jsonFileWatcher.js';
import { toPathKey } from './pathKey.js';
import type { AgentState } from './types.js';

/**
 * The sidebar's recent conversations: each Directory's newest transcripts,
 * titled the way the coding agent titles them, with the character their agent
 * wore so a resume brings that character back to its seat.
 *
 * The transcripts are the coding agent's (found through the provider); what
 * this module adds is the look, which only the office knows. It is recorded
 * per session in ~/.pixel-agents/conversations.json whenever the office saves
 * its seats — an agent's seat is only known to the office — so it outlives the
 * agent, and the newest CONVERSATION_LOOKS_MAX are kept.
 */

export type ConversationLook = Omit<AgentLook, 'id'> & {
  seatId?: string;
  /** When it was last recorded (ms), for pruning. */
  at: number;
};

type Looks = Record<string, ConversationLook>;

function looksPath(): string {
  return path.join(os.homedir(), PIXEL_AGENTS_DIR, CONVERSATIONS_FILE_NAME);
}

function readLooks(): Looks {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(looksPath(), 'utf-8'));
    if (!isRecord(raw)) return {};
    const looks: Looks = {};
    for (const [sessionId, look] of Object.entries(raw)) {
      const l = look as Partial<ConversationLook> | null;
      if (!l || !Number.isInteger(l.palette) || !Number.isInteger(l.repeat)) continue;
      looks[sessionId] = {
        palette: l.palette!,
        repeat: l.repeat!,
        seatId: typeof l.seatId === 'string' ? l.seatId : undefined,
        at: typeof l.at === 'number' ? l.at : 0,
      };
    }
    return looks;
  } catch {
    return {};
  }
}

/**
 * Renumber the remembered looks after the character list changed (see characterRemap.ts):
 * a look whose character was deleted is forgotten.
 */
export function remapConversationLooks(remap: (palette: number) => number | undefined): void {
  const looks = readLooks();
  let changed = false;
  for (const [sessionId, look] of Object.entries(looks)) {
    const next = remap(look.palette);
    if (next === look.palette) continue;
    changed = true;
    if (next === undefined) delete looks[sessionId];
    else look.palette = next;
  }
  if (!changed) return;
  try {
    writeJsonAtomic(looksPath(), looks);
  } catch (err) {
    console.error('[Pixel Agents] Failed to save conversation looks:', err);
  }
}

/** The look a session's agent last had, if the office ever saw it. */
export function conversationLook(sessionId: string): ConversationLook | undefined {
  return readLooks()[sessionId];
}

/**
 * Remember what the agents in `seats` (a saveAgentSeats payload, keyed by
 * agent id) wear and where they sit, under their session ids. Writes only
 * when something changed: the office saves its seats often.
 */
/**
 * Whether `agent` runs its own session, not one it shares with its Lead:
 * background-spawn children and inline Teammates carry the Lead's session id,
 * and must not take over the Lead's entry. A Teammate with a session of its
 * own (an implicit-team or tmux one) runs it.
 */
function runsOwnSession(agent: AgentState, store: AgentStateStore): boolean {
  if (agent.spawnToolUseId) return false;
  if (agent.leadAgentId === undefined) return true;
  return store.get(agent.leadAgentId)?.sessionId !== agent.sessionId;
}

export function recordConversationLooks(
  store: AgentStateStore,
  seats: Record<string, { seatId?: string }>,
): void {
  const looks = readLooks();
  let changed = false;
  const now = Date.now();
  for (const [idStr, meta] of Object.entries(seats)) {
    const agent = store.get(Number(idStr));
    if (!agent?.sessionId || agent.palette === undefined || !runsOwnSession(agent, store)) {
      continue;
    }
    const before = looks[agent.sessionId];
    const look: ConversationLook = {
      palette: agent.palette,
      repeat: agent.repeat ?? 0,
      seatId: typeof meta.seatId === 'string' ? meta.seatId : before?.seatId,
      at: now,
    };
    if (
      before &&
      before.palette === look.palette &&
      before.repeat === look.repeat &&
      before.seatId === look.seatId
    ) {
      continue;
    }
    looks[agent.sessionId] = look;
    changed = true;
  }
  if (!changed) return;
  const kept = Object.entries(looks)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, CONVERSATION_LOOKS_MAX);
  try {
    writeJsonAtomic(looksPath(), Object.fromEntries(kept));
  } catch (err) {
    console.error('[Pixel Agents] Failed to save conversation looks:', err);
  }
}

/** Where a Directory's sessions are filed (the provider knows the CLI's rule,
 *  e.g. a Directory reached through a symlink filed under the resolved path). */
function sessionDirsFor(provider: HookProvider, directoryPath: string): string[] {
  return provider.getSessionDirs?.(directoryPath) ?? [];
}

/** Where a Directory's sessions are filed: its own session dirs, and those
 *  of the folders below it (HookProvider.getNestedSessionDirs: a session that
 *  moved into a worktree or a subrepo is filed there). */
interface DirectoryFolders {
  own: string[];
  nested: string[];
}

function foldersOf(provider: HookProvider, directoryPath: string): DirectoryFolders {
  const own = sessionDirsFor(provider, directoryPath);
  const ownKeys = new Set(own.map(toPathKey));
  const nested = (provider.getNestedSessionDirs?.(directoryPath) ?? []).filter(
    (dir) => !ownKeys.has(toPathKey(dir)),
  );
  return { own, nested };
}

/** A session's transcript in the Directory at `directoryPath` or in a folder
 *  below it, if it exists: the copy the listing shows (preferredCopy) when
 *  the coding agent left another one behind. The provider's
 *  `sessionFilePattern` names transcripts: `*` is the session id. */
export function findTranscript(
  provider: HookProvider,
  directoryPath: string,
  sessionId: string,
): string | undefined {
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  const { own, nested } = foldersOf(provider, directoryPath);
  let chosen: TranscriptFile | undefined;
  for (const dir of [...own, ...nested]) {
    const file = path.join(dir, `${sessionId}${suffix}`);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      const copy = { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
      chosen = chosen ? preferredCopy(provider, chosen, copy) : copy;
    } catch {
      // Not filed there.
    }
  }
  return chosen?.path;
}

/**
 * Where a resumed session has to run when its transcript is filed below the
 * Directory (`transcript` from findTranscript): the working directory the
 * transcript records for that folder, the CLI looking for a session where it
 * runs. Undefined for one filed under the Directory itself, or when the
 * transcript records none or it is gone (the Directory then).
 */
function resumeCwd(
  provider: HookProvider,
  directoryPath: string,
  transcript: string,
): string | undefined {
  const folder = toPathKey(path.dirname(transcript));
  if (sessionDirsFor(provider, directoryPath).some((dir) => toPathKey(dir) === folder)) {
    return undefined;
  }
  const cwd = provider.transcriptCwd?.(transcript);
  if (!cwd) return undefined;
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** An agent in the office, as the list needs it: which one runs a session,
 *  what it wears, and whether it has no terminal here (`headless`). */
export interface LiveSession {
  agentId: number;
  palette?: number;
  repeat?: number;
  headless?: true;
}

/** Which agent in the office runs each session (keyed by session id). */
export function liveSessions(store: AgentStateStore): Map<string, LiveSession> {
  // Children and inline Teammates share their lead's session: the lead runs it.
  return new Map(
    [...store]
      .filter(([, agent]) => runsOwnSession(agent, store))
      .map(([id, agent]) => [
        agent.sessionId,
        {
          agentId: id,
          palette: agent.palette,
          repeat: agent.repeat,
          ...(agent.isExternal ? { headless: true as const } : {}),
        },
      ]),
  );
}

/**
 * The sessions running right now where the office did not launch them, by
 * session id: what the CLI says runs (HookProvider.liveSessions: its registry
 * of running processes, and its background service), less the processes in
 * `ownPids` (the office's terminals). Resuming one in a terminal starts a
 * second process on the session; one in the background service is attached
 * to instead (`kind: 'background'`, which wins when a session is both).
 * Empty when the provider keeps no such record.
 */
export function sessionsLiveElsewhere(
  provider: HookProvider,
  ownPids: ReadonlySet<number>,
): Map<string, LiveElsewhere> {
  const elsewhere = new Map<string, LiveElsewhere>();
  for (const session of provider.liveSessions?.() ?? []) {
    if (session.pid !== undefined && ownPids.has(session.pid)) continue;
    const known = elsewhere.get(session.sessionId);
    if (known && (known.kind === 'background' || session.kind !== 'background')) continue;
    elsewhere.set(session.sessionId, liveElsewhereOf(session));
  }
  return elsewhere;
}

function liveElsewhereOf(session: LiveCliSession): LiveElsewhere {
  return {
    ...(session.name ? { name: session.name } : {}),
    ...(session.status ? { status: session.status } : {}),
    ...(session.kind === 'background'
      ? {
          kind: 'background' as const,
          ...(session.state ? { state: session.state } : {}),
          ...(session.backgroundId ? { backgroundId: session.backgroundId } : {}),
        }
      : {}),
  };
}

/** The short id of the background session running `sessionId`, if the CLI
 *  says one does (HookProvider.liveSessions): opening it means attaching. */
export function backgroundIdOf(provider: HookProvider, sessionId: string): string | undefined {
  return provider
    .liveSessions?.()
    .find((s) => s.kind === 'background' && s.sessionId === sessionId && s.backgroundId)
    ?.backgroundId;
}

/** A resumable session id: a UUID, never anything a CLI could read as a flag. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What resuming a conversation needs, checked. */
export interface ResumeRequest {
  sessionId: string;
  directoryPath: string;
  transcript: string;
  /** The look its agent last had, if the office ever saw it. */
  look: ConversationLook | undefined;
  /** The Headless agent running it (adopted from another terminal): it takes
   *  the new terminal, keeping its id, character and seat. */
  agentId?: number;
  /** The session runs in the CLI's background service under this short id:
   *  the terminal attaches to it (`claude attach`) instead of resuming it. */
  attach?: string;
  /** Where the session runs when that is a folder below the Directory (it
   *  moved into a worktree or a subrepo, and its transcript is filed there):
   *  the terminal starts there. Absent: in the Directory. */
  cwd?: string;
}

/**
 * A `resumeConversation` request, or null when there is nothing to resume:
 * the provider lists no conversations (only one that names them is asked to
 * resume one, see HookProvider.buildLaunchCommand), the id isn't a UUID (it
 * becomes a CLI argument), the Directory isn't a string, an agent with a
 * terminal in the office already runs the session, or its transcript doesn't
 * exist. A session run by a Headless agent is resumed into that agent
 * (`agentId`): the CLI runs a second process on the same session id. A
 * session live in the CLI's background service is attached to (`attach`),
 * never resumed: a resume would start a copy beside it. The transcript may
 * be filed below the Directory (a session that moved into a worktree or a
 * subrepo): the resume then runs where the transcript says it runs (`cwd`).
 */
export function resumeRequest(
  store: AgentStateStore,
  provider: HookProvider,
  msg: { sessionId?: unknown; directoryPath?: unknown },
): ResumeRequest | null {
  if (!provider.conversationTitle || !provider.buildLaunchCommand) return null;
  const { sessionId, directoryPath } = msg;
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  if (typeof directoryPath !== 'string') return null;
  const holders = [...store.values()].filter((agent) => agent.sessionId === sessionId);
  const headless = holders.find((agent) => agent.isExternal && runsOwnSession(agent, store));
  // Already in the office with a terminal: nothing to bring back.
  if (holders.length > 0 && !headless) return null;
  const transcript = findTranscript(provider, directoryPath, sessionId);
  if (!transcript) return null;
  const attach = backgroundIdOf(provider, sessionId);
  const cwd = resumeCwd(provider, directoryPath, transcript);
  return {
    sessionId,
    directoryPath,
    transcript,
    look: conversationLook(sessionId),
    ...(headless ? { agentId: headless.id } : {}),
    ...(attach ? { attach } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

/** A transcript as the listing sees it. */
interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
  /** Filed under a folder below its Directory: that folder's name past the
   *  Directory's own (what the row shows when the transcript records no
   *  working directory). */
  nested?: string;
}

/** What the listing shows of a transcript besides its look: its title and the
 *  colour the user marked its session with (/color; HookProvider.sessionInfo). */
interface TranscriptLabel {
  title: string | undefined;
  color: string | undefined;
}

/**
 * Titles (and colours) already read, by transcript path, with the size and
 * mtime they were read at. Both are a function of the file, so an entry is
 * used only while both still match (any write changes them). Untitled results
 * are kept too, or every untitled session would be re-read on each listing. A
 * listing drops the entries of transcripts it no longer finds (a search shares
 * them).
 */
const titleCache = new Map<string, TranscriptLabel & { size: number; mtimeMs: number }>();

function cachedLabel(provider: HookProvider, file: TranscriptFile): TranscriptLabel {
  const hit = titleCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit;
  const label: TranscriptLabel = {
    title: provider.conversationTitle?.(file.path),
    color: provider.sessionInfo?.(file.path).color,
  };
  titleCache.set(file.path, { ...label, size: file.size, mtimeMs: file.mtimeMs });
  return label;
}

/** The working directories already read (HookProvider.transcriptCwd), kept
 *  as titleCache keeps titles: while the transcript's size and mtime hold. */
const cwdCache = new Map<string, { cwd: string | undefined; size: number; mtimeMs: number }>();

function cachedCwd(provider: HookProvider, file: TranscriptFile): string | undefined {
  const hit = cwdCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.cwd;
  const cwd = provider.transcriptCwd?.(file.path);
  cwdCache.set(file.path, { cwd, size: file.size, mtimeMs: file.mtimeMs });
  return cwd;
}

/** Forget what was read of transcripts no listing finds any more. */
function pruneCaches(found: ReadonlySet<string>): void {
  for (const cache of [titleCache, cwdCache]) {
    for (const cached of cache.keys()) if (!found.has(cached)) cache.delete(cached);
  }
}

/**
 * Each Directory's transcripts (in `directories` order), newest first: those
 * filed under its own folders, and those filed under the folders below it
 * (`nested`). A folder below two Directories, one inside the other, goes to
 * the inner one; a Directory's own folder is never another's. A session filed
 * in several folders (the coding agent may leave a copy behind when one
 * moves) is placed once, from its newest copy (preferredCopy).
 */
function placedTranscripts(
  directories: readonly Directory[],
  provider: HookProvider,
): TranscriptFile[][] {
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  const folders = directories.map((directory) => foldersOf(provider, directory.path));
  const ownKeys = new Set(folders.flatMap((f) => f.own).map(toPathKey));
  const nestedKeys = folders.map((f) => new Set(f.nested.map(toPathKey)));
  // Directory j is inside Directory i when one of j's own folders is below i.
  const inside = (j: number, i: number) =>
    folders[j].own.some((dir) => nestedKeys[i].has(toPathKey(dir)));
  const claimant = new Map<string, number>();
  folders.forEach((f, i) => {
    for (const dir of f.nested) {
      const key = toPathKey(dir);
      if (ownKeys.has(key)) continue;
      const held = claimant.get(key);
      if (held === undefined || inside(i, held)) claimant.set(key, i);
    }
  });
  const placed = folders.map((f, i) => [
    ...f.own.flatMap((dir) => transcriptsIn(dir, suffix)),
    ...f.nested
      .filter((dir) => claimant.get(toPathKey(dir)) === i)
      .flatMap((dir) => {
        const nested = nestedFolderName(f.own, dir);
        return transcriptsIn(dir, suffix).map((file) => ({ ...file, nested }));
      }),
  ]);
  const sessionOf = (file: TranscriptFile) => path.basename(file.path, suffix);
  const chosen = new Map<string, TranscriptFile>();
  for (const file of placed.flat()) {
    const held = chosen.get(sessionOf(file));
    chosen.set(sessionOf(file), held ? preferredCopy(provider, held, file) : file);
  }
  return placed.map((files) =>
    files
      .filter((file) => chosen.get(sessionOf(file))?.path === file.path)
      .sort((a, b) => b.mtimeMs - a.mtimeMs),
  );
}

/**
 * Which of two copies of one session's transcript stands for it: a titled
 * one over an untitled one (a copy a process started in another folder
 * wrote before its first prompt holds no history), else the newer one. The
 * same file twice (two Directories filing sessions in one folder) is itself.
 */
function preferredCopy(
  provider: HookProvider,
  a: TranscriptFile,
  b: TranscriptFile,
): TranscriptFile {
  if (a.path === b.path) return a;
  const titledA = cachedLabel(provider, a).title !== undefined;
  const titledB = cachedLabel(provider, b).title !== undefined;
  if (titledA !== titledB) return titledA ? a : b;
  return b.mtimeMs > a.mtimeMs ? b : a;
}

/** A folder below a Directory, named past the Directory's own folder and the
 *  separator after it (the longest of its own folders that prefixes it). */
function nestedFolderName(own: readonly string[], dir: string): string {
  const name = path.basename(dir);
  const base = own
    .map((o) => path.basename(o))
    .filter((o) => name.length > o.length + 1 && name.startsWith(o))
    .sort((a, b) => b.length - a.length)[0];
  return base ? name.slice(base.length + 1) : name;
}

/**
 * Where a transcript filed below its Directory runs, relative to the
 * Directory (`/`-separated): from the working directory it records
 * (HookProvider.transcriptCwd), else its folder's name. Undefined for one in
 * the Directory itself; null when the working directory it records is not
 * below the Directory after all (folder names are lossy: `/work/web-app`
 * files like a folder `app` below `/work/web`).
 */
function subpathOf(
  file: TranscriptFile,
  directory: Directory,
  provider: HookProvider,
): string | undefined | null {
  if (file.nested === undefined) return undefined;
  const cwd = cachedCwd(provider, file);
  if (cwd === undefined) return file.nested;
  for (const base of directoryBases(directory.path)) {
    const rel = path.relative(base, cwd);
    if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
  }
  return null;
}

/** A Directory's path as given and with its symlinks resolved. */
function directoryBases(directoryPath: string): string[] {
  try {
    const resolved = fs.realpathSync(directoryPath);
    return resolved === directoryPath ? [directoryPath] : [directoryPath, resolved];
  } catch {
    return [directoryPath];
  }
}

/** A transcript as a listed conversation, or null when it has no title (a
 *  past session that never got a prompt; a running one is "New conversation"). */
function conversationOf(
  file: TranscriptFile,
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  looks: Looks,
  elsewhere: ReadonlyMap<string, LiveElsewhere>,
  done: ReadonlyMap<string, number>,
  subpath?: string,
): Conversation | null {
  const sessionId = path.basename(file.path, transcriptSuffix(provider.sessionFilePattern));
  const running = live.get(sessionId);
  const label = cachedLabel(provider, file);
  const title = label.title ?? (running && NEW_CONVERSATION_TITLE);
  if (!title) return null;
  const look = running ?? looks[sessionId];
  return {
    sessionId,
    title,
    ...(label.color ? { color: label.color } : {}),
    updatedAt: file.mtimeMs,
    ...(subpath ? { subpath } : {}),
    palette: look?.palette,
    repeat: look?.repeat,
    agentId: running?.agentId,
    ...(running?.headless ? { headless: true } : {}),
    liveElsewhere: elsewhere.get(sessionId),
    ...(done.has(sessionId) ? { done: true } : {}),
  };
}

/** How many past conversations a Directory lists: its `limits` entry, within
 *  bounds, else CONVERSATIONS_PER_DIRECTORY. */
export function conversationLimitsFrom(limits: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(limits)) return out;
  for (const entry of limits.slice(0, CONVERSATIONS_LIMIT_ENTRIES_MAX)) {
    if (!isRecord(entry) || typeof entry.directoryPath !== 'string') continue;
    const count = entry.count;
    if (typeof count !== 'number' || !Number.isInteger(count)) continue;
    out.set(entry.directoryPath, clampLimit(count));
  }
  return out;
}

function clampLimit(count: number): number {
  return Math.min(Math.max(count, 1), CONVERSATIONS_LIMIT_MAX);
}

/**
 * Each Directory's newest conversations: the ones an agent in the office is
 * running (with its id and what it wears now; titled "New conversation" until
 * the coding agent titles it) and past ones, by when they were last written,
 * at most the Directory's `limits` entry (else CONVERSATIONS_PER_DIRECTORY)
 * of them all told; `more` says older ones exist. A past one without a title
 * (a session that never got a prompt) is left out. One running in a terminal
 * the office did not launch carries `liveElsewhere` (sessionsLiveElsewhere),
 * one whose agent has no terminal here `headless`. One whose session is
 * marked done (`done`, HookProvider.sessionMarks) is left out, counted in
 * `doneHidden` and in neither the cap nor `more`: the search still finds it.
 * A Directory's list takes in the sessions filed below it (placedTranscripts),
 * each with its `subpath`.
 */
export function listConversations(
  directories: readonly Directory[],
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  limits: ReadonlyMap<string, number> = new Map(),
  elsewhere: ReadonlyMap<string, LiveElsewhere> = new Map(),
  done: ReadonlyMap<string, number> = new Map(),
): DirectoryConversations[] {
  const looks = readLooks();
  const found = new Set<string>();
  const suffix = transcriptSuffix(provider.sessionFilePattern);
  const placed = placedTranscripts(directories, provider);
  const listed = directories.map((directory, index): DirectoryConversations => {
    const limit = limits.get(directory.path) ?? CONVERSATIONS_PER_DIRECTORY;
    const conversations: Conversation[] = [];
    let more = false;
    let doneHidden = 0;
    for (const file of placed[index]) {
      found.add(file.path);
      const isDone = done.has(path.basename(file.path, suffix));
      // Past the cap, titles are read only until one says there are more.
      if (!isDone && more) continue;
      const subpath = subpathOf(file, directory, provider);
      if (subpath === null) continue;
      const conversation = () =>
        conversationOf(file, provider, live, looks, elsewhere, done, subpath);
      if (isDone) {
        if (conversation()) doneHidden++;
        continue;
      }
      if (conversations.length >= limit) {
        more = conversation() !== null;
        continue;
      }
      const listedOne = conversation();
      if (listedOne) conversations.push(listedOne);
    }
    return {
      name: directory.name,
      path: directory.path,
      conversations,
      ...(more ? { more } : {}),
      ...(doneHidden > 0 ? { doneHidden } : {}),
    };
  });
  pruneCaches(found);
  return listed;
}

/** What a search asks for. */
export interface ConversationQuery {
  query: string;
  /** Only this Directory's (else every Directory's). */
  directoryPath?: string;
  limit: number;
}

/** A `searchConversations` request, checked; null when malformed. */
export function conversationQueryFrom(msg: {
  query?: unknown;
  directoryPath?: unknown;
  limit?: unknown;
}): ConversationQuery | null {
  if (typeof msg.query !== 'string' || typeof msg.limit !== 'number') return null;
  if (!Number.isInteger(msg.limit)) return null;
  if (msg.directoryPath !== undefined && typeof msg.directoryPath !== 'string') return null;
  return {
    query: msg.query.slice(0, CONVERSATION_QUERY_MAX_CHARS),
    ...(msg.directoryPath !== undefined ? { directoryPath: msg.directoryPath } : {}),
    limit: clampLimit(msg.limit),
  };
}

/** Whether `title` holds every word of `query` (any case). */
export function titleMatches(title: string, query: string): boolean {
  const lower = title.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => lower.includes(word));
}

/**
 * The conversations whose title matches `query` (titleMatches), across every
 * Directory or the one asked for, newest first, at most `limit`; `more`: at
 * least one more matches. A session listed under two Directories counts once.
 * Done ones are found too, with `done` (the sidebar's lists leave them out).
 * Sessions filed below a Directory are its, as in listConversations.
 */
export function searchConversations(
  directories: readonly Directory[],
  provider: HookProvider,
  live: ReadonlyMap<string, LiveSession>,
  { query, directoryPath, limit }: ConversationQuery,
  elsewhere: ReadonlyMap<string, LiveElsewhere> = new Map(),
  done: ReadonlyMap<string, number> = new Map(),
): { results: FoundConversation[]; more: boolean } {
  const looks = readLooks();
  const placed = placedTranscripts(directories, provider);
  const files = directories
    .flatMap((directory, index) => placed[index].map((file) => ({ file, directory })))
    .filter(({ directory }) => directoryPath === undefined || directory.path === directoryPath)
    .sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  const results: FoundConversation[] = [];
  const sessions = new Set<string>();
  for (const { file, directory } of files) {
    const subpath = subpathOf(file, directory, provider);
    if (subpath === null) continue;
    const conversation = conversationOf(file, provider, live, looks, elsewhere, done, subpath);
    if (!conversation || sessions.has(conversation.sessionId)) continue;
    if (!titleMatches(conversation.title, query)) continue;
    if (results.length === limit) return { results, more: true };
    sessions.add(conversation.sessionId);
    results.push({ directoryPath: directory.path, directoryName: directory.name, conversation });
  }
  return { results, more: false };
}

/** A project dir's transcripts: its files ending in `suffix`. */
function transcriptsIn(projectDir: string, suffix: string): TranscriptFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch {
    return [];
  }
  const files: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const file = path.join(projectDir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Gone between the listing and the stat.
    }
  }
  return files;
}
