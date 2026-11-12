import * as path from 'path';

import { createAgentState } from '../agentState.js';
import type { RemoteHost } from '../configPersistence.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import type { RemoteSession } from '../providers/hook/claude/remoteListing.js';
import {
  mirrorPath,
  mirrorTranscript,
  remoteAgentOf,
  remoteAttachArgs,
  remoteCanOpen,
  remoteTailArgs,
} from '../remoteHosts.js';
import { admitTerminalAgent, type LaunchStandaloneAgentDeps } from './standaloneAgentLauncher.js';
import { inheritedEnv, terminalEnv } from './terminalEnv.js';

/**
 * Open a session of a remote host in the office (remoteHosts.ts): its
 * terminal attaches to the host's tmux over ssh, and while it is open a
 * character works off a local copy of the transcript, fed by an ssh tail.
 * Closing the terminal ends both; the remote tmux and its session live on.
 * A service (`svc-` name) attaches to the tmux it runs in and nothing else.
 * Returns the agent id, or null when the terminal is unavailable, the
 * session is already open, or it is a service outside tmux.
 */
export function launchRemoteAgent(
  deps: LaunchStandaloneAgentDeps,
  host: RemoteHost,
  session: RemoteSession,
  tailCommand = 'ssh',
): number | null {
  const { store, runtime, ptyManager, provider } = deps;
  if (!ptyManager.isAvailable()) {
    console.error(`[Pixel Agents] Terminal: cannot open -- ${ptyManager.unavailableReason()}`);
    return null;
  }
  if (remoteAgentOf(store, host.name, session.sessionId) !== undefined) return null;
  if (!remoteCanOpen(session)) return null;

  const id = store.nextAgentId.current++;
  let terminal;
  try {
    terminal = ptyManager.create({
      agentId: id,
      command: 'ssh',
      args: remoteAttachArgs(host, session),
      cwd: process.cwd(),
      env: terminalEnv(inheritedEnv(provider)),
    });
  } catch (err) {
    store.nextAgentId.current--;
    console.error(`[Pixel Agents] Terminal: spawn failed: ${String(err)}`);
    return null;
  }

  // The copy starts with the title records (and the title the list shows,
  // as a generated one: a later title replaces it, a rename wins over it).
  const file = mirrorPath(host.name, session.sessionId);
  const seed = [
    ...session.labelLines,
    JSON.stringify({ type: 'ai-title', aiTitle: session.title, sessionId: session.sessionId }),
  ];
  const mirror = mirrorTranscript(
    file,
    seed,
    tailCommand,
    remoteTailArgs(host, session.transcript),
  );
  terminal.onExit(() => mirror.stop());

  const agent = createAgentState({
    id,
    sessionId: session.sessionId,
    isExternal: false,
    projectDir: path.dirname(file),
    jsonlFile: file,
    directoryName: path.basename(session.cwd),
    providerId: provider.id,
    remoteHost: host.name,
    ...(session.service ? { remoteService: true } : {}),
  });
  // Only what the session does from now on: its past is the seed's titles.
  agent.fileOffset = mirror.seedBytes;
  assignPaletteIfNeeded(agent, store);
  admitTerminalAgent(deps, agent, terminal);
  runtime.activeAgentId.current = id;
  store.persist();
  console.log(`[Pixel Agents] Terminal: Agent ${id} - opened ${session.sessionId} on ${host.name}`);
  return id;
}
