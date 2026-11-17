/**
 * Superseded transcripts: a session that a `/clear` (or a `/resume` in the
 * same process) left behind, and the session that continues it.
 *
 * Claude Code 2.1.325 fires neither SessionEnd(reason=clear) nor
 * SessionStart(source=clear) on `/clear`, so the hook path that moves an
 * agent to the new session (hookEventHandler's `pendingClear`) never runs:
 * the agent kept the closed transcript and the new session came in as a
 * second character on its first Stop. What does change is the CLI's registry
 * of running processes: the same pid names another session. So the office
 *
 * - watches every live process's session (registrySwitches: pid + start time
 *   → session id, between polls) and, when one switches, moves the agent that
 *   ran the old session to the new one, or merges it with the agent that
 *   already runs the new one (continueSession);
 * - when it was not running at the time, infers the link from the
 *   transcripts (inferSupersededLinks), narrowly: a wrong link hides a
 *   conversation that is not over;
 * - remembers each link in the office's saved state (`superseded` in
 *   standalone-state.json, SupersededSessions), so the sidebar leaves the old
 *   transcript out of its lists, labels it in the search, and never lets it
 *   become a character again.
 */

import * as fs from 'fs';
import * as path from 'path';

import { isRecord } from '../../core/src/isRecord.js';
import type { HookProvider, LiveCliSession, TranscriptSpan } from '../../core/src/provider.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  SUPERSEDE_INFER_MTIME_SLACK_MS,
  SUPERSEDE_INFER_WINDOW_MS,
  SUPERSEDE_REGISTRY_CHECK_MS,
} from './constants.js';
import type { AgentState } from './types.js';

/** A session id as the office stores one: a UUID, never a path or a flag. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One link: the session that continues a superseded one. */
export interface SupersededEntry {
  sessionId: string;
  /** When the office recorded it (ms since the epoch). */
  at: number;
  /** Inferred from the transcripts, not seen happen. */
  inferred?: true;
}

/** Every link, by the superseded session's id. */
export type SupersededMap = Record<string, SupersededEntry>;

/** The saved links, tolerant: anything that is not a link is dropped. */
export function parseSuperseded(raw: unknown): SupersededMap {
  const links: SupersededMap = {};
  if (!isRecord(raw)) return links;
  for (const [from, value] of Object.entries(raw)) {
    if (!SESSION_UUID.test(from) || !isRecord(value)) continue;
    const { sessionId, at, inferred } = value;
    if (typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId) || sessionId === from) {
      continue;
    }
    links[from] = {
      sessionId,
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      ...(inferred === true ? { inferred: true as const } : {}),
    };
  }
  return links;
}

/** What a listing needs of a link: the session that continues it in the end
 *  (after several clears, the newest) and whether any step was inferred. */
export interface Successor {
  sessionId: string;
  inferred?: true;
}

/**
 * The office's links, kept in its saved state (StateAdapter.loadSuperseded /
 * saveSuperseded). Read once, written on every change.
 */
export class SupersededSessions {
  private links: SupersededMap | null = null;

  constructor(
    private readonly io: {
      load: () => unknown;
      save: (links: SupersededMap) => void;
    },
  ) {}

  private all(): SupersededMap {
    this.links ??= parseSuperseded(this.io.load());
    return this.links;
  }

  /**
   * Record that `to` continues `from`. A session that runs again is not
   * superseded (its own link goes), so a `/resume` back to an earlier session
   * never makes a loop. A link seen happen is never replaced by an inferred
   * one. Returns whether anything changed.
   */
  record(from: string, to: string, opts: { inferred?: boolean; at?: number } = {}): boolean {
    if (from === to || !SESSION_UUID.test(from) || !SESSION_UUID.test(to)) return false;
    const links = this.all();
    let changed = false;
    if (links[to]) {
      delete links[to];
      changed = true;
    }
    const held = links[from];
    const inferred = opts.inferred === true;
    if (held && (held.sessionId === to || (inferred && !held.inferred))) {
      // The same link again; or an inference against one seen happen.
      if (held.sessionId === to && held.inferred && !inferred) delete held.inferred;
      else if (!changed) return false;
    } else {
      links[from] = {
        sessionId: to,
        at: opts.at ?? Date.now(),
        ...(inferred ? { inferred: true as const } : {}),
      };
    }
    this.io.save({ ...links });
    return true;
  }

  /** Forget that `sessionId` was superseded (it runs again). */
  forget(sessionId: string): boolean {
    const links = this.all();
    if (!links[sessionId]) return false;
    delete links[sessionId];
    this.io.save({ ...links });
    return true;
  }

  isSuperseded(sessionId: string): boolean {
    return this.all()[sessionId] !== undefined;
  }

  /** The session that continues `sessionId` in the end, or undefined when it
   *  is not superseded. A chain is followed to its newest session. */
  successorOf(sessionId: string): Successor | undefined {
    const links = this.all();
    let link = links[sessionId];
    if (!link) return undefined;
    let inferred = link.inferred === true;
    const seen = new Set([sessionId]);
    while (links[link.sessionId] && !seen.has(link.sessionId)) {
      seen.add(link.sessionId);
      link = links[link.sessionId];
      inferred ||= link.inferred === true;
    }
    return { sessionId: link.sessionId, ...(inferred ? { inferred: true as const } : {}) };
  }

  /** Every superseded session with the one that continues it in the end. */
  successors(): Map<string, Successor> {
    const out = new Map<string, Successor>();
    for (const from of Object.keys(this.all())) {
      const successor = this.successorOf(from);
      if (successor) out.set(from, successor);
    }
    return out;
  }

  /** Drop the links whose transcripts are gone (either side), as the done
   *  marks are dropped: the files follow the CLI's own cleanup. */
  prune(exists: (sessionId: string) => boolean): boolean {
    const links = this.all();
    let changed = false;
    for (const [from, link] of Object.entries(links)) {
      if (exists(from) && exists(link.sessionId)) continue;
      delete links[from];
      changed = true;
    }
    if (changed) this.io.save({ ...links });
    return changed;
  }
}

// ── Seen happen: the registry ────────────────────────────────

/** A live process that now runs another session than at the last poll. */
export interface RegistrySwitch {
  pid: number;
  from: string;
  to: string;
  /** Where the process runs, as the CLI records it. */
  cwd?: string;
}

/** A process's identity across polls: its pid and, when known, when it
 *  started (a later process given the same pid is another one). */
function processKey(session: LiveCliSession): string | undefined {
  if (session.pid === undefined) return undefined;
  return `${session.pid}:${session.startedAt ?? ''}`;
}

/**
 * The processes in `sessions` that ran another session at the last poll
 * (`previous`: process key → session id), and the map for the next poll.
 * A process seen for the first time is no switch.
 */
export function registrySwitches(
  previous: ReadonlyMap<string, string>,
  sessions: readonly LiveCliSession[],
): { switches: RegistrySwitch[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const switches: RegistrySwitch[] = [];
  for (const session of sessions) {
    const key = processKey(session);
    if (key === undefined || next.has(key)) continue;
    next.set(key, session.sessionId);
    const before = previous.get(key);
    if (before !== undefined && before !== session.sessionId) {
      switches.push({
        pid: session.pid!,
        from: before,
        to: session.sessionId,
        ...(session.cwd ? { cwd: session.cwd } : {}),
      });
    }
  }
  return { switches, next };
}

// ── Inferred: the transcripts ────────────────────────────────

/** What inference reads of a transcript. */
export interface TranscriptFacts {
  sessionId: string;
  path: string;
  mtimeMs: number;
  /** The user's own name for the session (a rename or `--name`); a
   *  generated title links nothing. */
  title?: string;
  /** The working directory the session runs in. */
  cwd?: string;
  span: TranscriptSpan;
}

/**
 * The links the transcripts show, for sessions cleared while the office was
 * not running. `b` continues `a` only when all of these hold:
 *
 * - both are filed in the same folder, under the same user title and the same
 *   working directory;
 * - `b` began with a `/clear` (its head holds the command) and its first
 *   record comes after `a`'s last one;
 * - `a` is not running (`live`), and `b` is running or newer than `a`;
 * - `a` is the latest such session before `b`, and no other session with that
 *   title was still running when `b` began (then it is not known which one
 *   was cleared, and none is linked).
 *
 * A wrong link hides a conversation that is not over; a missing one only
 * leaves a row in the list. So when in doubt, nothing is linked.
 */
export function inferSupersededLinks(
  transcripts: readonly TranscriptFacts[],
  live: ReadonlySet<string>,
): Array<{ from: string; to: string }> {
  const groups = new Map<string, TranscriptFacts[]>();
  for (const t of transcripts) {
    if (!t.title || !t.cwd) continue;
    const key = `${path.dirname(t.path)}\0${t.title}\0${t.cwd}`;
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }
  const links: Array<{ from: string; to: string }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const used = new Set<string>();
    const cleared = group
      .filter((t) => t.span.cleared && t.span.firstAt !== undefined)
      .sort((x, y) => x.span.firstAt! - y.span.firstAt!);
    for (const b of cleared) {
      const start = b.span.firstAt!;
      const others = group.filter((t) => t !== b);
      // Another session with this title still running when b began.
      const rival = others.some(
        (t) =>
          (t.span.firstAt === undefined || t.span.firstAt < start) &&
          (t.span.lastAt === undefined || t.span.lastAt >= start),
      );
      if (rival) continue;
      const before = others
        .filter((t) => t.span.lastAt !== undefined && t.span.lastAt < start)
        .sort((x, y) => y.span.lastAt! - x.span.lastAt!);
      const a = before[0];
      if (!a || used.has(a.sessionId) || live.has(a.sessionId)) continue;
      if (!live.has(b.sessionId) && !(b.mtimeMs > a.mtimeMs)) continue;
      used.add(a.sessionId);
      links.push({ from: a.sessionId, to: b.sessionId });
    }
  }
  return links;
}

/** A transcript a listing found. */
export interface ListedTranscript {
  path: string;
  size: number;
  mtimeMs: number;
}

/** What was read of each transcript, kept while its size and mtime hold. */
const factsCache = new Map<string, { size: number; mtimeMs: number; facts: TranscriptFacts }>();

function factsOf(provider: HookProvider, file: ListedTranscript, suffix: string): TranscriptFacts {
  const hit = factsCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.facts;
  const info = provider.sessionInfo?.(file.path);
  const facts: TranscriptFacts = {
    sessionId: path.basename(file.path, suffix),
    path: file.path,
    mtimeMs: file.mtimeMs,
    ...(info?.titleIsUsers && info.title ? { title: info.title } : {}),
    cwd: provider.transcriptCwd?.(file.path),
    span: provider.transcriptSpan?.(file.path) ?? {},
  };
  factsCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, facts });
  return facts;
}

/**
 * The links inferSupersededLinks finds among `files` (the transcripts of the
 * office's Directories), reading only what can matter: the transcripts
 * written in the last SUPERSEDE_INFER_WINDOW_MS, and of those only the ones
 * in a folder where one began with a `/clear` and the ones written since
 * shortly before it (a `/clear` writes to the old transcript as it leaves it).
 */
export function inferFromTranscripts(
  provider: HookProvider,
  files: readonly ListedTranscript[],
  live: ReadonlySet<string>,
  now: number = Date.now(),
): Array<{ from: string; to: string }> {
  if (!provider.transcriptSpan || !provider.sessionInfo) return [];
  const suffix = provider.sessionFilePattern?.replace('*', '') ?? '.jsonl';
  const recent = files.filter((f) => now - f.mtimeMs <= SUPERSEDE_INFER_WINDOW_MS);
  const starts = recent
    .map((f) => ({ file: f, span: spanOf(provider, f) }))
    .filter(({ span }) => span.cleared && span.firstAt !== undefined);
  if (starts.length === 0) return [];
  const wanted = new Map<string, ListedTranscript>();
  for (const { file, span } of starts) {
    const folder = path.dirname(file.path);
    for (const f of recent) {
      if (path.dirname(f.path) !== folder) continue;
      if (f === file || f.mtimeMs >= span.firstAt! - SUPERSEDE_INFER_MTIME_SLACK_MS) {
        wanted.set(f.path, f);
      }
    }
  }
  const facts = [...wanted.values()].map((f) => factsOf(provider, f, suffix));
  return inferSupersededLinks(facts, live);
}

/** The span alone (the cheap first pass), from the facts cache when it holds. */
const spanCache = new Map<string, { size: number; mtimeMs: number; span: TranscriptSpan }>();

function spanOf(provider: HookProvider, file: ListedTranscript): TranscriptSpan {
  const hit = spanCache.get(file.path);
  if (hit && hit.size === file.size && hit.mtimeMs === file.mtimeMs) return hit.span;
  const span = provider.transcriptSpan?.(file.path) ?? {};
  spanCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, span });
  return span;
}

// ── Applying a link to the office's agents ───────────────────

/** The office's terminals, as far as merging needs them. */
export interface SupersedeTerminals {
  has(agentId: number): boolean;
  dispose(agentId: number): void;
}

export interface SupersedeDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  provider: HookProvider;
  superseded: SupersededSessions;
  /** Absent where the office runs no terminals of its own. */
  terminals?: SupersedeTerminals;
}

/** The main agent running `sessionId` (Teammates and background spawns
 *  share their lead's id: the lead runs it). */
function mainAgentOf(store: AgentStateStore, sessionId: string): AgentState | undefined {
  for (const agent of store.values()) {
    if (agent.sessionId !== sessionId || agent.spawnToolUseId) continue;
    if (agent.leadAgentId !== undefined && store.get(agent.leadAgentId)?.sessionId === sessionId) {
      continue;
    }
    return agent;
  }
  return undefined;
}

/**
 * Where session `sessionId`'s transcript is: beside `besides` (the session
 * it continues) unless the process's working directory says otherwise, else
 * wherever the provider files it. Undefined when it is nowhere yet.
 */
export function transcriptOfSession(
  provider: HookProvider,
  sessionId: string,
  besides?: string,
  cwd?: string,
): string | undefined {
  const name = `${sessionId}${provider.sessionFilePattern?.replace('*', '') ?? '.jsonl'}`;
  const dirs = [
    ...(cwd ? (provider.getSessionDirs?.(cwd) ?? []) : []),
    ...(besides ? [path.dirname(besides)] : []),
  ];
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  for (const root of provider.getAllSessionRoots?.() ?? []) {
    let projects: string[];
    try {
      projects = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      const file = path.join(root, project, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return dirs[0] ? path.join(dirs[0], name) : undefined;
}

/** Whether a session's transcript exists anywhere the provider files them. */
export function sessionTranscriptExists(provider: HookProvider, sessionId: string): boolean {
  const found = transcriptOfSession(provider, sessionId);
  return found !== undefined && fs.existsSync(found);
}

/**
 * Session `to` continues session `from`: record it, and give the office one
 * character for it. The agent that ran `from` moves to `to` (its transcript,
 * its hook routing), keeping its id, look, seat and card. When another agent
 * already runs `to` (adopted on its first hook before the switch was seen),
 * the two merge: the one with a terminal in the office stays, else the older
 * one, and the other leaves.
 */
export function continueSession(
  deps: SupersedeDeps,
  from: string,
  to: string,
  opts: { cwd?: string; inferred?: boolean } = {},
): void {
  const { store, runtime, provider, superseded, terminals } = deps;
  superseded.record(from, to, { inferred: opts.inferred });
  const holder = mainAgentOf(store, from);
  if (!holder) return;
  const other = mainAgentOf(store, to);
  if (other && other !== holder) {
    const keep = keeperOf(holder, other, terminals);
    const drop = keep === holder ? other : holder;
    console.log(
      `[Pixel Agents] Superseded: Agents ${holder.id} and ${other.id} run one session (${to.slice(0, 8)}), keeping Agent ${keep.id}`,
    );
    removeDuplicate(deps, drop, drop === holder ? from : undefined);
    if (keep === other) return;
  }
  const transcript = transcriptOfSession(provider, to, holder.jsonlFile, opts.cwd);
  console.log(
    `[Pixel Agents] Superseded: Agent ${holder.id} - session ${from.slice(0, 8)} continues as ${to.slice(0, 8)}${opts.inferred ? ' (inferred)' : ''}`,
  );
  runtime.reassignSession(holder.id, to, transcript);
}

/** Of two agents on one session, the one to keep: the one with a terminal in
 *  the office, else the older one (the lower id). */
export function keeperOf<T extends { id: number }>(
  a: T,
  b: T,
  terminals?: { has(agentId: number): boolean },
): T {
  const aHas = terminals?.has(a.id) === true;
  const bHas = terminals?.has(b.id) === true;
  if (aHas !== bHas) return aHas ? a : b;
  return a.id <= b.id ? a : b;
}

/** Take a duplicate agent out of the office. Its transcript is dismissed for
 *  good only when it is the superseded one (`supersededTranscriptOf`). */
function removeDuplicate(deps: SupersedeDeps, agent: AgentState, supersededSession?: string): void {
  const { runtime, terminals } = deps;
  runtime.removeTeammates(agent.id);
  runtime.subagentWatch.removeByLead(agent.id);
  if (terminals?.has(agent.id)) terminals.dispose(agent.id);
  runtime.unregisterAgent(agent.sessionId);
  if (supersededSession !== undefined && agent.jsonlFile) {
    runtime.dismissalTracker.permanentlyDismiss(agent.jsonlFile);
  }
  runtime.removeAgent(agent.id);
}

/**
 * Bring the office's agents in line with the links: an agent still on a
 * superseded session moves to (or merges with) the one that continues it
 * (after a restart, or a link just inferred).
 */
export function reconcileSupersededAgents(deps: SupersedeDeps): void {
  const successors = deps.superseded.successors();
  if (successors.size === 0) return;
  for (const agent of [...deps.store.values()]) {
    const successor = successors.get(agent.sessionId);
    if (!successor || mainAgentOf(deps.store, agent.sessionId) !== agent) continue;
    continueSession(deps, agent.sessionId, successor.sessionId, {
      inferred: successor.inferred === true,
    });
  }
}

/**
 * Infer links among the office's transcripts (inferFromTranscripts), record
 * the new ones and move the agents. Run at startup and on each listing.
 * Also drops the links whose transcripts are gone. Returns whether anything
 * changed.
 */
export function applyInferredLinks(
  deps: SupersedeDeps,
  files: readonly ListedTranscript[],
): boolean {
  const { provider, superseded } = deps;
  const live = new Set((provider.liveSessions?.() ?? []).map((s) => s.sessionId));
  let changed = false;
  for (const { from, to } of inferFromTranscripts(provider, files, live)) {
    if (superseded.successorOf(from)) continue;
    console.log(
      `[Pixel Agents] Superseded: session ${from.slice(0, 8)} was cleared into ${to.slice(0, 8)} (inferred from the transcripts)`,
    );
    superseded.record(from, to, { inferred: true });
    changed = true;
  }
  if (changed) reconcileSupersededAgents(deps);
  return changed;
}

/** Forget the links of sessions that run again (a session resumed in a
 *  terminal is a conversation again, not a leftover). */
function forgetLive(superseded: SupersededSessions, sessions: readonly LiveCliSession[]): void {
  for (const session of sessions) {
    if (superseded.isSuperseded(session.sessionId)) superseded.forget(session.sessionId);
  }
}

/**
 * Watch the CLI's running processes (HookProvider.registeredSessions) for one
 * that switched session (a `/clear`, or a `/resume` in place) every
 * SUPERSEDE_REGISTRY_CHECK_MS, and apply each
 * (continueSession). `onChange` runs after a switch was applied. Returns the
 * stop.
 */
export function watchSupersededSessions(
  deps: SupersedeDeps,
  onChange: () => void = () => {},
  intervalMs: number = SUPERSEDE_REGISTRY_CHECK_MS,
): () => void {
  const { provider } = deps;
  // The registry alone: polled every few seconds, it must not run the CLI.
  const read = () => provider.registeredSessions?.() ?? [];
  let known = registrySwitches(new Map(), read()).next;
  const check = () => {
    const sessions = read();
    const { switches, next } = registrySwitches(known, sessions);
    known = next;
    for (const s of switches) {
      console.log(
        `[Pixel Agents] Superseded: process ${s.pid} went from session ${s.from.slice(0, 8)} to ${s.to.slice(0, 8)}`,
      );
      continueSession(deps, s.from, s.to, { cwd: s.cwd });
    }
    forgetLive(deps.superseded, sessions);
    if (switches.length > 0) onChange();
  };
  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
