import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Conversation, RemoteHostConversations } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import { readConfig, type RemoteHost } from './configPersistence.js';
import {
  PIXEL_AGENTS_DIR,
  REMOTE_LISTING_MAX_AGE_MS,
  REMOTE_LISTING_TIMEOUT_MS,
  REMOTE_MIRROR_DIR_NAME,
  REMOTE_SSH_CONNECT_TIMEOUT_S,
} from './constants.js';
import {
  parseRemoteListing,
  REMOTE_LISTING_SCRIPT,
  type RemoteSession,
} from './providers/hook/claude/remoteListing.js';

/**
 * Remote hosts: Claude Code sessions on other machines, reached over ssh
 * (config.json `remoteHosts: [{ name, ssh }]`, `ssh` an alias from
 * ~/.ssh/config that logs in without a password).
 *
 * - Listing: one ssh per host runs REMOTE_LISTING_SCRIPT (the remote's
 *   python3) and the answer is cached here; the sidebar's requests refresh it
 *   once it is REMOTE_LISTING_MAX_AGE_MS old. A host that can't be reached
 *   shows offline, nothing else.
 * - Open: the agent's terminal is `ssh -t <ssh> tmux new-session -A ...`
 *   (remoteAttachArgs), so closing it closes only ssh: the remote tmux and
 *   the session in it live on. A service (`claude --name svc-<service>`)
 *   only attaches to the tmux it runs in: `tmux attach-session`, never a new
 *   session, never a resume.
 * - Character: while that terminal is open, `ssh <ssh> tail -F <transcript>`
 *   appends the transcript's new lines to a local copy (mirrorTranscript),
 *   which the office watches like any transcript.
 */

/** The remote hosts config.json lists. */
export function configuredRemoteHosts(): RemoteHost[] {
  return readConfig().remoteHosts;
}

/** What the office last heard from a host. */
interface HostListing {
  online: boolean;
  sessions: RemoteSession[];
  at: number;
}

const listings = new Map<string, HostListing>();
const inFlight = new Map<string, Promise<void>>();

/** ssh's options for a command that must never stop to ask for anything. */
function batchOptions(): string[] {
  return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${REMOTE_SSH_CONNECT_TIMEOUT_S}`];
}

/** Run the listing script on `host`: its stdout, or null when ssh or the
 *  script failed or took too long. */
function runListing(host: RemoteHost): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...batchOptions(), host.ssh, 'python3 -'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), REMOTE_LISTING_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? out : null);
    });
    child.stdin.on('error', () => {
      /* ssh gone before reading the script: its exit says so */
    });
    child.stdin.end(REMOTE_LISTING_SCRIPT);
  });
}

/**
 * Ask every host whose listing is missing or older than `maxAgeMs` for a new
 * one. Resolves once they have all answered (or failed); null when none was
 * stale, so the caller knows nothing will change.
 */
export function refreshRemoteHosts(
  hosts: readonly RemoteHost[],
  maxAgeMs = REMOTE_LISTING_MAX_AGE_MS,
  run: (host: RemoteHost) => Promise<string | null> = runListing,
): Promise<void> | null {
  const now = Date.now();
  const stale = hosts.filter((host) => {
    const listing = listings.get(host.name);
    return !inFlight.has(host.name) && (!listing || now - listing.at >= maxAgeMs);
  });
  if (stale.length === 0) return null;
  return Promise.all(
    stale.map((host) => {
      const pending = run(host).then((out) => {
        const sessions = out === null ? null : parseRemoteListing(out);
        listings.set(host.name, {
          online: sessions !== null,
          sessions: sessions ?? [],
          at: Date.now(),
        });
        inFlight.delete(host.name);
      });
      inFlight.set(host.name, pending);
      return pending;
    }),
  ).then(() => undefined);
}

/** Forget every listing (tests). */
export function clearRemoteListings(): void {
  listings.clear();
  inFlight.clear();
}

/** A listed session of a host, and the host: what opening it needs. */
export function remoteSessionOf(
  hosts: readonly RemoteHost[],
  hostName: unknown,
  sessionId: unknown,
): { host: RemoteHost; session: RemoteSession } | undefined {
  const host = hosts.find((h) => h.name === hostName);
  const session = host && listings.get(host.name)?.sessions.find((s) => s.sessionId === sessionId);
  return host && session ? { host, session } : undefined;
}

/** The agent in the office running a host's session, if any. */
export function remoteAgentOf(
  store: AgentStateStore,
  hostName: string,
  sessionId: string,
): number | undefined {
  for (const [id, agent] of store) {
    if (agent.remoteHost === hostName && agent.sessionId === sessionId) return id;
  }
  return undefined;
}

/** A listed session as a sidebar row: like a local conversation, with the
 *  agent open on it (if any) and what it is doing on its host (if running). */
function remoteConversation(
  session: RemoteSession,
  store: AgentStateStore,
  host: string,
): Conversation {
  const agentId = remoteAgentOf(store, host, session.sessionId);
  const agent = agentId !== undefined ? store.get(agentId) : undefined;
  return {
    sessionId: session.sessionId,
    title: session.title,
    ...(session.color ? { color: session.color } : {}),
    updatedAt: session.updatedAt,
    palette: agent?.palette,
    repeat: agent?.repeat,
    agentId,
    remoteKind: session.service ? 'service' : 'work',
    ...(session.live ? { remoteStatus: session.live.status ?? 'running' } : {}),
    // Running outside tmux: there is nothing to attach to, and opening it
    // resumes it, a second process on the session (the row asks first). A
    // service's row is not pressable then (remoteCanOpen).
    ...(session.live && !session.tmux
      ? {
          liveElsewhere: {
            ...(session.live.name ? { name: session.live.name } : {}),
            ...(session.live.status ? { status: session.live.status } : {}),
          },
        }
      : {}),
  };
}

/** Each host the office has heard from, with its work sessions newest first
 *  (all of the listing's: the sidebar pages them), then its services (only
 *  running ones are listed); a host not yet asked is left out until it
 *  answers. */
export function remoteHostConversations(
  hosts: readonly RemoteHost[],
  store: AgentStateStore,
): RemoteHostConversations[] {
  return hosts.flatMap((host) => {
    const listing = listings.get(host.name);
    if (!listing) return [];
    return [
      {
        name: host.name,
        online: listing.online,
        conversations: [
          ...listing.sessions.filter((s) => !s.service),
          ...listing.sessions.filter((s) => s.service),
        ].map((session) => remoteConversation(session, store, host.name)),
      },
    ];
  });
}

/** `value` as one word for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The tmux session a session opens in: the one it runs in, else one named
 *  after it (its registry name or title, then its id's first block, so it
 *  never lands in another session's). */
export function tmuxSessionName(session: RemoteSession): string {
  if (session.tmux) return session.tmux;
  const slug = (session.live?.name ?? session.title)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '');
  const id = session.sessionId.slice(0, 8);
  return slug ? `${slug}-${id}` : id;
}

/** Whether the office can open a session: a service only by attaching to
 *  the tmux session it runs in, so one outside tmux can't be opened. */
export function remoteCanOpen(session: RemoteSession): boolean {
  return !session.service || session.tmux !== undefined;
}

/**
 * The agent terminal's ssh arguments: attach to the session's tmux session,
 * creating it when missing with `claude --resume <id>` in the directory the
 * session started in (`-A` attaches when it exists, and then ignores the
 * directory and the command). A service only attaches (`=` matches the name
 * exactly): it runs under its own supervisor, and the office must never start
 * a second one beside it.
 */
export function remoteAttachArgs(host: RemoteHost, session: RemoteSession): string[] {
  if (session.service) {
    return ['-t', host.ssh, `tmux attach-session -t ${shellQuote(`=${session.tmux ?? ''}`)}`];
  }
  const tmux = [
    'tmux new-session -A',
    `-s ${shellQuote(tmuxSessionName(session))}`,
    `-c ${shellQuote(session.cwd)}`,
    shellQuote(`claude --resume ${session.sessionId}`),
  ].join(' ');
  return ['-t', host.ssh, tmux];
}

/**
 * The tail's ssh arguments: the transcript's new lines as they are written.
 * The remote shell waits on stdin and stops the tail when it closes: killing
 * the local ssh closes it, and without a terminal nothing else would stop a
 * tail on a transcript no one writes any more.
 */
export function remoteTailArgs(host: RemoteHost, transcript: string): string[] {
  const tail = `tail -n 0 -F ${shellQuote(transcript)} & t=$!; cat >/dev/null; kill $t`;
  return [...batchOptions(), host.ssh, tail];
}

/** Where the office keeps its copy of a host's transcript. */
export function mirrorPath(hostName: string, sessionId: string): string {
  return path.join(
    os.homedir(),
    PIXEL_AGENTS_DIR,
    REMOTE_MIRROR_DIR_NAME,
    hostName,
    `${sessionId}.jsonl`,
  );
}

/** Mirrors still running, stopped if the server exits first. */
const mirrors = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of mirrors) child.kill();
});

/**
 * Start a local copy of a remote transcript at `file`: first `seedLines`
 * (the transcript's title records, so its name and colour read as they would
 * from the remote file), then whatever `command args` prints (remoteTailArgs:
 * the new lines). Returns the seed's size, where the agent starts reading,
 * and `stop`, which ends the tail and removes the copy.
 */
export function mirrorTranscript(
  file: string,
  seedLines: readonly string[],
  command: string,
  args: string[],
): { seedBytes: number; stop: () => void } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seed = seedLines.map((line) => `${line}\n`).join('');
  fs.writeFileSync(file, seed);
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  mirrors.add(child);
  child.stdout?.pipe(fs.createWriteStream(file, { flags: 'a' }));
  child.on('error', (err) => console.error(`[Pixel Agents] Remote: tail failed: ${err.message}`));
  child.on('exit', () => mirrors.delete(child));
  return {
    seedBytes: Buffer.byteLength(seed),
    stop: () => {
      child.kill();
      mirrors.delete(child);
      fs.rmSync(file, { force: true });
    },
  };
}
