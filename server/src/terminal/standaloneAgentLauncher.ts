/**
 * Standalone agent launch: the PTY-backed counterpart to the VS Code adapter's
 * launchNewTerminal().
 *
 * This deliberately MIRRORS adapters/vscode/agentManager.ts rather than sharing
 * a core seam with it: that function imports `vscode` (so it can't move into
 * server/) and takes twelve positional dependencies, so unifying the two would
 * mean rewriting the whole VS Code lifecycle -- out of scope here and a certain
 * conflict with the sibling branches. What IS shared is the thing that matters:
 * both call provider.buildLaunchCommand(), so the launched command is identical.
 * Unifying the hosting is deferred (docs/design/standalone-terminal.md).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { TerminalSessionOpened } from '../../../core/src/messages.js';
import type { BackgroundSessionStart, HookProvider } from '../../../core/src/provider.js';
import type { PersistedAgent } from '../../../core/src/schemas.js';
import { isPersistedSpawnChild, restoredAgentInit } from '../agentPersistence.js';
import type { AgentRuntime } from '../agentRuntime.js';
import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { JSONL_POLL_INTERVAL_MS } from '../constants.js';
import { clearContextUsage } from '../contextUsage.js';
import { sessionsLiveElsewhere } from '../conversations.js';
import { directoryAt } from '../directories.js';
import { startFileWatching } from '../fileWatcher.js';
import { directoryNameFor, hostDirectory } from '../hostDirectory.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import type { AgentState } from '../types.js';
import { inheritedEnv, terminalEnv } from './terminalEnv.js';
import type { TerminalSession, TerminalSessions } from './terminalSessions.js';

export interface LaunchStandaloneAgentDeps {
  store: AgentStateStore;
  runtime: AgentRuntime;
  ptyManager: TerminalSessions;
  provider: HookProvider;
}

export interface LaunchStandaloneAgentOptions {
  /** Path of the Directory to launch into. Defaults to the server's cwd, which
   *  is also the Directory standalone contributes as its host entry. */
  directoryPath?: string;
  /** Read from the host's persisted permission posture by the caller; never a
   *  per-launch choice made in the office. */
  bypassPermissions?: boolean;
  /** The character picked from the roster (a palette index). Out of range or
   *  absent, the Directory's default characters apply, else a random pick. */
  palette?: number;
  /** Resume this past session instead of starting a new one: same session
   *  id, same transcript (read from its end), and the seat its agent sat in
   *  when that one is free. With `agentId`, the Headless agent running the
   *  session takes the terminal instead of a new agent coming in: same id,
   *  character, seat and card, its transcript already watched. With `attach`,
   *  the session runs in the CLI's background service under that short id:
   *  the terminal attaches to it instead of resuming it. */
  resume?: {
    sessionId: string;
    transcript: string;
    seatId?: string;
    agentId?: number;
    attach?: string;
  };
  /** A new session already started in the CLI's background service
   *  (launchBackgroundAgent): the agent takes its id and the terminal
   *  attaches to it, so the session outlives the terminal and this server. */
  background?: BackgroundSessionStart;
  cols?: number;
  rows?: number;
}

/**
 * Spawn a Claude agent in a PTY and register it with the runtime.
 * Returns the new agent id, or null when the terminal is unavailable.
 */
export function launchStandaloneAgent(
  deps: LaunchStandaloneAgentDeps,
  options: LaunchStandaloneAgentOptions = {},
): number | null {
  const { store, runtime, ptyManager, provider } = deps;

  if (!ptyManager.isAvailable()) {
    console.error(`[Pixel Agents] Terminal: cannot launch -- ${ptyManager.unavailableReason()}`);
    return null;
  }

  const cwd = options.directoryPath ?? process.cwd();
  const sessionId =
    options.resume?.sessionId ?? options.background?.sessionId ?? crypto.randomUUID();
  const attach = options.resume?.attach ?? options.background?.backgroundId;

  const launch = provider.buildLaunchCommand?.(sessionId, cwd, {
    bypassPermissions: options.bypassPermissions,
    resume: options.resume !== undefined,
    ...(attach ? { attach } : {}),
  });
  if (!launch) {
    console.error('[Pixel Agents] Terminal: provider.buildLaunchCommand is not implemented');
    return null;
  }

  const dirs = provider.getSessionDirs?.(cwd) ?? [];
  if (dirs.length === 0) {
    console.error('[Pixel Agents] Terminal: provider returned no session dirs');
    return null;
  }
  // A resumed session's transcript is wherever the CLI filed it (under the
  // Directory's resolved path, when it was reached through a symlink).
  const jsonlFile = options.resume?.transcript ?? path.join(dirs[0], `${sessionId}.jsonl`);
  const projectDir = path.dirname(jsonlFile);

  // A Headless agent running the session (its process in a terminal the
  // office did not launch) takes this terminal: no second character.
  const headless =
    options.resume?.agentId !== undefined ? store.get(options.resume.agentId) : undefined;
  if (headless && !headless.isExternal) return null;
  const id = headless?.id ?? store.nextAgentId.current++;

  // The Directory launched into, if the cwd is one: its name and its default characters.
  const directory = directoryAt(cwd, [hostDirectory()]);
  const agent =
    headless ??
    createAgentState({
      id,
      sessionId,
      // Not external: this server owns the process. External agents are the ones
      // adopted from someone else's terminal, and they're what the stale-check and
      // restore paths act on -- a PTY agent must be excluded from both.
      isExternal: false,
      projectDir,
      jsonlFile,
      // The character's origin label (and its Area-mapping key): the name of the
      // Directory it was launched into, as the user named it — so an entry called
      // "Side Project" labels its agents that, not "side-project", and the Areas
      // it was assigned in the modal actually match. Falls back to the basename
      // for a cwd that is no Directory at all.
      directoryName: directory?.name ?? directoryNameFor(cwd),
      providerId: provider.id,
      seatId: options.resume?.seatId,
    });
  if (options.resume && !headless) {
    // Its history is the past: replaying it would resurrect finished tools.
    try {
      agent.fileOffset = fs.statSync(agent.jsonlFile).size;
    } catch {
      // No transcript after all: read it from the start once it appears.
    }
  }

  // Server-side, like every other creation path: the palette rides the
  // agentCreated broadcast and is persisted with the agent, so a reload
  // restores the same character without the webview having to save it back.
  assignPaletteIfNeeded(agent, store, { picked: options.palette, directory });

  let session;
  try {
    session = ptyManager.create({
      agentId: id,
      command: launch.command,
      args: launch.args,
      cwd,
      // The locale too (terminalEnv), here as well as in the PTY: a PTY host
      // started by an older server spawns with the env it is handed.
      env: terminalEnv({ ...inheritedEnv(provider), ...launch.env }),
      cols: options.cols,
      rows: options.rows,
    });
  } catch (err) {
    // Roll the id back so a failed spawn doesn't burn an agent id (a Headless
    // agent that was to take it stays as it was).
    if (!headless) store.nextAgentId.current--;
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    return null;
  }

  // Not external from here on: this server owns a process on its session.
  agent.isExternal = false;
  // Set before admitting: the terminal's announcement carries it.
  agent.wheelReports = launch.wheelReports || undefined;
  admitTerminalAgent(deps, agent, session);
  // A fresh session starts with an empty context: a full gauge from the spawn on.
  // A resumed one keeps its gauge, read from its transcript.
  if (!options.resume) clearContextUsage(id, store);
  runtime.activeAgentId.current = id;
  store.persist();

  const pid = session.pid !== null ? ` (pid ${session.pid})` : '';
  const how = attach ? `attached to background session ${attach}` : undefined;
  const what = headless
    ? `took a terminal on session ${sessionId}${how ? ` (${how})` : ''}`
    : (how ?? (options.resume ? `resumed session ${sessionId}` : `spawned ${launch.command}`));
  console.log(`[Pixel Agents] Terminal: Agent ${id} - ${what}${pid} in ${cwd}`);
  return id;
}

/**
 * The + Agent launch: start the session in the CLI's background service
 * (HookProvider.startBackgroundSession, Claude's `claude --bg`) and attach a
 * terminal to it, so the agent keeps running when the terminal closes or this
 * server stops. When the CLI cannot start one (an older CLI, a folder it does
 * not trust yet, a bypass disclaimer never accepted: each needs a terminal to
 * ask in), the session starts in the terminal as before. The new agent's id
 * (a promise while the CLI starts the session; at once where the provider has
 * no background service), or null when nothing launched.
 */
export function launchBackgroundAgent(
  deps: LaunchStandaloneAgentDeps,
  options: Omit<LaunchStandaloneAgentOptions, 'resume' | 'background'> = {},
): number | null | Promise<number | null> {
  const { provider, ptyManager } = deps;
  if (!ptyManager.isAvailable()) return launchStandaloneAgent(deps, options);
  const cwd = options.directoryPath ?? process.cwd();
  const launch = provider.buildLaunchCommand?.('', cwd, {});
  const starting = provider.startBackgroundSession?.(cwd, {
    bypassPermissions: options.bypassPermissions,
    env: terminalEnv({ ...inheritedEnv(provider), ...launch?.env }),
  });
  // No background service here: the launch stays as it always was.
  if (!starting) return launchStandaloneAgent(deps, options);
  return starting.then((background) => {
    if (!background) return launchStandaloneAgent(deps, options);
    // One character per session: a Headless agent adopted from its hooks
    // while `claude --bg` ran takes the terminal instead of a second one.
    const holder = [...deps.store.values()].find((a) => a.sessionId === background.sessionId);
    if (holder?.isExternal) {
      return launchStandaloneAgent(deps, {
        ...options,
        resume: {
          sessionId: background.sessionId,
          transcript: holder.jsonlFile,
          agentId: holder.id,
          attach: background.backgroundId,
        },
      });
    }
    if (holder) return holder.id;
    return launchStandaloneAgent(deps, { ...options, background });
  });
}

/**
 * Bring back the agents whose terminals outlived the last server (only the
 * PTY host keeps them; in process there are none). Runs before the server
 * accepts connections, so the first office to connect already sees them —
 * and before anything persists, which would drop them from the saved list.
 *
 * Each agent is rebuilt from the saved list (team, look, spawns): shutting
 * down never empties it. Its transcript is read from its current end: what it
 * did while no server was watching is history, and replaying it would
 * resurrect finished tools.
 */
export function reattachTerminalAgents(deps: LaunchStandaloneAgentDeps): number[] {
  const { store, ptyManager } = deps;
  const saved = new Map(store.loadPersistedAgents().map((p) => [p.id, p]));
  const restored: number[] = [];

  for (const session of ptyManager.survivors()) {
    const id = session.agentId;
    // Never hand a new launch an id a live terminal still holds.
    if (id >= store.nextAgentId.current) store.nextAgentId.current = id + 1;
    if (store.has(id)) continue;
    const record = saved.get(id);
    if (!record) {
      console.warn(
        `[Pixel Agents] Terminal: Agent ${id} - running in the PTY host with no saved record; left out of the office.`,
      );
      continue;
    }

    // Restored from where the transcript really is: the finished-spawn check
    // must read the same file the agent will watch.
    const agent = createAgentState({
      ...restoredAgentInit(relocatedRecord(deps.provider, record)),
      isExternal: false,
      providerId: deps.provider.id,
    });
    try {
      agent.fileOffset = fs.statSync(agent.jsonlFile).size;
    } catch {
      // No transcript yet: it starts from the beginning once it appears.
    }
    assignPaletteIfNeeded(agent, store);
    admitTerminalAgent(deps, agent, session);
    restored.push(id);
    console.log(`[Pixel Agents] Terminal: Agent ${id} - reattached (pid ${session.pid})`);
  }

  if (restored.length > 0) store.persist();
  return restored;
}

/** The sessions running in the CLI's background service right now, by id
 *  (HookProvider.liveSessions, from its last answer). */
export function backgroundSessionIds(provider: HookProvider): Set<string> {
  return new Set(
    (provider.liveSessions?.() ?? [])
      .filter((s) => s.kind === 'background')
      .map((s) => s.sessionId),
  );
}

/**
 * Bring back, Headless, the agents whose session outlived the last server in
 * the CLI's background service (launched with + Agent, or attached to): their
 * terminals were only clients of it. `saved` is the saved list as it was
 * before this server touched it (reattachTerminalAgents rewrites it). They
 * come back with their id, look and seat, and pressing their conversation
 * attaches again. When none did, nothing changes here and the saved external
 * agents come back as before, on the first connect.
 */
export async function restoreBackgroundAgents(
  deps: Pick<LaunchStandaloneAgentDeps, 'store' | 'runtime' | 'provider'>,
  saved: readonly PersistedAgent[],
): Promise<number[]> {
  const { store, runtime, provider } = deps;
  if (!provider.refreshLiveSessions) return [];
  await provider.refreshLiveSessions();
  const live = backgroundSessionIds(provider);
  const outlived = saved.filter(
    (p) => !store.has(p.id) && !!p.sessionId && live.has(p.sessionId) && !isPersistedSpawnChild(p),
  );
  if (outlived.length === 0) return [];
  // The other saved external agents too: the list written after this restore
  // is the one the first connect would have restored them from.
  const records = saved
    .filter((p) => p.isExternal || outlived.includes(p))
    .map((p) => (p.isExternal ? p : { ...p, isExternal: true }));
  runtime.restoreExternalAgents(records);
  const restored = outlived.map((p) => p.id).filter((id) => store.has(id));
  console.log(
    `[Pixel Agents] Background: ${restored.length} agent(s) still running in the background, back as Headless`,
  );
  return restored;
}

/**
 * What an in-process server stopping does with its agents: every terminal is
 * gone, so the next server starts with none, except the Headless ones whose
 * session runs on in the CLI's background service (their terminal only
 * detached): those stay in the saved list for the next server to bring back
 * (restoreBackgroundAgents). Run after the terminals exited.
 */
export function keepBackgroundAgentsOnShutdown(
  deps: Pick<LaunchStandaloneAgentDeps, 'store' | 'runtime' | 'provider'>,
): void {
  const { store, runtime, provider } = deps;
  const live = backgroundSessionIds(provider);
  const keep = (id: number) => {
    const agent = store.get(id);
    return !!agent && agent.isExternal && live.has(agent.sessionId) && !agent.spawnToolUseId;
  };
  runtime.stop();
  for (const id of [...store.keys()]) {
    if (!keep(id)) runtime.removeAgent(id);
  }
  store.persist();
}

/**
 * The saved record with its transcript where it really is, when that isn't
 * where the record says. Older servers saved the path under the Directory as
 * given, but the CLI files it under the symlink-resolved path, so such an
 * agent never got its transcript (and none of its sub-agents) watched. The
 * session id is a UUID, so the one `<sessionId>.jsonl` under the session roots
 * is its own. Returns the record itself when nothing moved.
 */
function relocatedRecord(provider: HookProvider, record: PersistedAgent): PersistedAgent {
  if (fs.existsSync(record.jsonlFile)) return record;
  const name = path.basename(record.jsonlFile);
  for (const root of provider.getAllSessionRoots?.() ?? []) {
    let dirs: string[];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, name);
      if (!fs.existsSync(file)) continue;
      console.log(`[Pixel Agents] Terminal: Agent ${record.id} - transcript found at ${file}`);
      return { ...record, jsonlFile: file, projectDir: path.dirname(file) };
    }
  }
  return record;
}

/** The announcement of an agent's terminal, saying whether its program
 *  scrolls by wheel reports it never asks for (the client then turns the
 *  wheel into them on the alternate screen, terminal/wheelReports.ts). */
export function terminalSessionOpenedMessage(agent: AgentState): TerminalSessionOpened {
  return {
    type: 'terminalSessionOpened',
    agentId: agent.id,
    ...(agent.wheelReports ? { wheelReports: true } : {}),
  };
}

/** What every agent with a terminal gets, launched or reattached: a place in
 *  the office, its drawer tab, its removal when the process ends, and its
 *  transcript watched. When the process ends while another terminal (one the
 *  office did not launch) still runs its session, the agent stays, Headless,
 *  as it would have been adopted: its session is still live. */
export function admitTerminalAgent(
  deps: LaunchStandaloneAgentDeps,
  agent: AgentState,
  session: TerminalSession,
): void {
  const { store, runtime } = deps;
  const id = agent.id;

  // Pre-register the expected JSONL so the project scanner doesn't mistake it
  // for a /clear file, exactly as the VS Code path does.
  runtime.knownJsonlFiles.add(agent.jsonlFile);
  store.set(id, agent);
  runtime.registerAgent(agent.sessionId, id);

  // Tell the UI a terminal exists for this agent, so the drawer opens a tab.
  // A separate message (rather than a field on agentCreated) keeps the protocol
  // change additive for the sibling branches.
  store.broadcast({ ...terminalSessionOpenedMessage(agent) });

  // The terminal closing is this surface's equivalent of VS Code's
  // "terminal closed -> clean up orphan" pass in fileWatcher.
  session.onExit((exit) => {
    console.log(`[Pixel Agents] Terminal: Agent ${id} - exited (code ${exit.exitCode})`);
    store.broadcast({ type: 'terminalSessionClosed', agentId: id, exitCode: exit.exitCode });
    if (store.get(id) !== agent) return;
    if (runsElsewhere(deps.provider, agent.sessionId)) {
      agent.isExternal = true;
      store.persist();
      console.log(`[Pixel Agents] Terminal: Agent ${id} - still running elsewhere, kept headless`);
      // That answer may be a few seconds old (the CLI's list is cached): ask
      // again, and close the agent if the session ended with this terminal.
      void deps.provider.refreshLiveSessions?.().then(() => {
        if (store.get(id) !== agent || !agent.isExternal) return;
        if (runsElsewhere(deps.provider, agent.sessionId)) return;
        console.log(`[Pixel Agents] Terminal: Agent ${id} - its session ended after all, closing`);
        runtime.unregisterAgent(agent.sessionId);
        runtime.closeAgent(id);
      });
      return;
    }
    runtime.unregisterAgent(agent.sessionId);
    runtime.closeAgent(id);
  });

  // A Headless agent taking a terminal is watched already.
  if (!runtime.pollingTimers.has(id)) startJsonlPoll(deps, id, agent);
}

/** Whether something the office did not launch runs `sessionId` right now:
 *  another terminal (the CLI's registry) or the CLI's background service
 *  (this server's own terminals are excluded by the caller, whose process
 *  has exited). */
function runsElsewhere(provider: HookProvider, sessionId: string): boolean {
  return sessionsLiveElsewhere(provider, new Set()).has(sessionId);
}

/**
 * Wait for the session's JSONL to appear, then start watching it.
 *
 * Hooks (the default) already route by sessionId, so this is what backfills tool
 * content and keeps hooks-off standalone working at all. Unlike the VS Code
 * path this does NOT implement /resume reassignment: a launch either names a
 * fresh --session-id or --resume's an existing one, so the transcript is
 * known up front either way.
 */
function startJsonlPoll(deps: LaunchStandaloneAgentDeps, id: number, agent: AgentState): void {
  const { store, runtime } = deps;
  let pollCount = 0;

  const timer = setInterval(() => {
    pollCount++;
    try {
      if (!fs.existsSync(agent.jsonlFile)) {
        if (pollCount === 10) {
          console.warn(
            `[Pixel Agents] Terminal: Agent ${id} - JSONL not found after 10s. Expected: ${agent.jsonlFile}`,
          );
        }
        return;
      }
      clearInterval(timer);
      runtime.jsonlPollTimers.delete(id);
      // The agent may have been closed while we waited.
      if (!store.has(id)) return;
      console.log(
        `[Pixel Agents] Terminal: Agent ${id} - found JSONL ${path.basename(agent.jsonlFile)}`,
      );
      startFileWatching(
        id,
        agent.jsonlFile,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
      );
    } catch {
      // File may not exist yet, or vanished mid-check; keep polling.
    }
  }, JSONL_POLL_INTERVAL_MS);

  runtime.jsonlPollTimers.set(id, timer);
}
