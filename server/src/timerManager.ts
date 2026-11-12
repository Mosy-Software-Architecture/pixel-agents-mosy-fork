import type { AgentStateStore } from './agentStateStore.js';
import { PERMISSION_TIMER_DELAY_MS, QUIET_TURN_IDLE_MS } from './constants.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';
import type { AgentState } from './types.js';

/**
 * The `agentStatus` a finished turn broadcasts ("Done"). Call it before the
 * agent is marked at rest: it reads `turnActive`. A turn end rings for the
 * user only when the office saw that turn start and the agent's work is
 * over. With background spawns still live, a lead only pauses until they
 * report (`pausedForSpawns`); a turn the office never saw start (an agent
 * restored or adopted at rest, a late idle report) is `silent`.
 */
export function turnEndStatus(
  agentId: number,
  agent: AgentState,
  opts: { silent?: boolean } = {},
): Record<string, unknown> {
  const spawns = agent.backgroundSpawns.size;
  return {
    type: 'agentStatus',
    id: agentId,
    status: 'waiting',
    awaitingInput: false,
    pausedForSpawns: spawns > 0 ? spawns : undefined,
    silent: opts.silent || !agent.turnActive || undefined,
  };
}

export function clearAgentActivity(
  agent: AgentState | undefined,
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  if (!agent) return;

  // Preserve background agent tools — only clear foreground state.
  // The subagent maps are keyed by parentToolId; deleting a non-parent key is a
  // safe no-op, so no tool-name check is needed here.
  if (agent.backgroundSpawns.size > 0) {
    for (const toolId of agent.activeToolIds) {
      if (agent.backgroundSpawns.has(toolId)) continue;
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
    }
  } else {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
  }

  agent.isWaiting = false;
  agent.turnActive = true;
  agent.permissionSent = false;
  cancelPermissionTimer(agentId, permissionTimers);
  agents.broadcast({ type: 'agentToolsClear', id: agentId });
  // Re-send background agent tools so webview re-creates their sub-agents.
  // toolName + runInBackground are REQUIRED: without them the webview can't
  // recognize the re-sent tool as a subagent spawn and never recreates the
  // Subtask sub-character. Skip tools whose spawn became its own character
  // (named background teammate) -- re-sending would spawn a ghost alongside it.
  for (const toolId of agent.backgroundSpawns.keys()) {
    if (hasPromotedBackgroundAgent(agentId, toolId, agents)) continue;
    const status = agent.activeToolStatuses.get(toolId);
    if (status) {
      agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName: agent.activeToolNames.get(toolId),
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }
  }
  agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
}

/**
 * A heuristic agent whose turn went quiet: still marked active, no foreground
 * tool running, nothing written for QUIET_TURN_IDLE_MS. Its turn ended with no
 * turn_duration to say so (an interrupted turn writes none), so it would read
 * "working" until its next turn. A fallback: local commands, the common case,
 * start no turn at all (HookProvider.startsNoTurn). Hook-delivered agents are
 * left to their hooks.
 */
export function isQuietTurn(agent: AgentState, now: number): boolean {
  if (agent.hookDelivered || agent.isWaiting || !agent.turnActive) return false;
  const hasForegroundTools = agent.activeToolIds.size > agent.backgroundSpawns.size;
  return !hasForegroundTools && now - agent.lastDataAt > QUIET_TURN_IDLE_MS;
}

/** Mark every quiet-turn agent waiting ("Done"), as a turn_duration would,
 *  but silently: no transcript record said the turn ended. */
export function endQuietTurns(
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  now = Date.now(),
): void {
  for (const [id, agent] of agents) {
    if (!isQuietTurn(agent, now)) continue;
    cancelWaitingTimer(id, waitingTimers);
    const status = turnEndStatus(id, agent, { silent: true });
    agent.isWaiting = true;
    agent.turnActive = false;
    agents.broadcast(status);
  }
}

export function cancelWaitingTimer(
  agentId: number,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = waitingTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    waitingTimers.delete(agentId);
  }
}

export function startWaitingTimer(
  agentId: number,
  delayMs: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  cancelWaitingTimer(agentId, waitingTimers);
  const timer = setTimeout(() => {
    waitingTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;
    // Heuristic text-idle timer: the turn ended without a clear idle signal,
    // so this is "Done", not "Waiting for input".
    const status = turnEndStatus(agentId, agent);
    agent.isWaiting = true;
    agent.turnActive = false;
    agents.broadcast(status);
  }, delayMs);
  waitingTimers.set(agentId, timer);
}

export function cancelPermissionTimer(
  agentId: number,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const timer = permissionTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    permissionTimers.delete(agentId);
  }
}

export function startPermissionTimer(
  agentId: number,
  agents: AgentStateStore,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionExemptTools: ReadonlySet<string>,
): void {
  cancelPermissionTimer(agentId, permissionTimers);
  const timer = setTimeout(() => {
    permissionTimers.delete(agentId);
    const agent = agents.get(agentId);
    if (!agent) return;

    // Only flag if there are still active non-exempt tools (parent or sub-agent)
    let hasNonExempt = false;
    for (const toolId of agent.activeToolIds) {
      const toolName = agent.activeToolNames.get(toolId);
      if (!permissionExemptTools.has(toolName || '')) {
        hasNonExempt = true;
        break;
      }
    }

    // Check sub-agent tools for non-exempt tools
    const stuckSubagentParentToolIds: string[] = [];
    for (const [parentToolId, subToolNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subToolNames) {
        if (!permissionExemptTools.has(toolName)) {
          stuckSubagentParentToolIds.push(parentToolId);
          hasNonExempt = true;
          break;
        }
      }
    }

    if (hasNonExempt) {
      agent.permissionSent = true;
      console.log(`[Pixel Agents] Timer: Agent ${agentId} - possible permission wait detected`);
      agents.broadcast({
        type: 'agentToolPermission',
        id: agentId,
      });
      // Also notify stuck sub-agents
      for (const parentToolId of stuckSubagentParentToolIds) {
        agents.broadcast({
          type: 'subagentToolPermission',
          id: agentId,
          parentToolId,
        });
      }
    }
  }, PERMISSION_TIMER_DELAY_MS);
  permissionTimers.set(agentId, timer);
}
