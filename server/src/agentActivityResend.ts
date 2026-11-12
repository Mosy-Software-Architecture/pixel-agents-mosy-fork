import type { AgentStateStore } from './agentStateStore.js';
import { sessionInfoMessage } from './sessionInfo.js';
import { hasPromotedBackgroundAgent } from './teamUtils.js';

/**
 * Replay an agent's active state to a connecting client.
 *
 * Order matters:
 * 1. Team info first — webview needs team context before tool messages
 * 2. Regular tools
 * 3. Background tools with runInBackground + isTeammateSpawn flags, skipping promoted spawns
 * 4. Waiting or active status
 * 5. Context usage
 * 6. Session name and colour
 */
export function resendAgentActivity(
  send: (message: Record<string, unknown>) => void,
  store: AgentStateStore,
): void {
  for (const [id, agent] of store) {
    // 1. Team metadata first — webview uses this to route tool messages correctly.
    // Derived teams (named background spawns) have a name and a lead link but NO
    // teamName, so gate on any team field.
    if (agent.teamName || agent.agentName || agent.isTeamLead) {
      send({
        type: 'agentTeamInfo',
        id,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
        teamUsesTmux: agent.teamUsesTmux,
      });
    }

    // 2. Regular (non-background) tools
    for (const [toolId, status] of agent.activeToolStatuses) {
      // Skip background tools here — they're sent separately below with proper flags
      if (agent.backgroundSpawns.has(toolId)) continue;

      const toolName = agent.activeToolNames.get(toolId) ?? '';
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        // A live permission wait: without it the office clears the bubble.
        permissionActive: agent.permissionSent || undefined,
      });
    }

    // 3. Background tools with runInBackground flag. Skip promoted spawns to prevent
    // ghost Subtask characters alongside the real teammate character.
    for (const toolId of agent.backgroundSpawns.keys()) {
      if (hasPromotedBackgroundAgent(id, toolId, store)) continue;

      const status = agent.activeToolStatuses.get(toolId);
      if (!status) continue;

      const toolName = agent.activeToolNames.get(toolId);
      send({
        type: 'agentToolStart',
        id,
        toolId,
        status,
        toolName,
        permissionActive: agent.permissionSent || undefined,
        runInBackground: true,
        isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
      });
    }

    // 4. Waiting status, or active: a turn between two tools has no live tool
    // to say so, and a restored agent starts at rest. Silent: a snapshot, not
    // a turn that just ended (no chime, nothing pending).
    // Waiting mid-turn is a question to the user; after the turn, a lead with
    // live spawns is only paused on them.
    if (agent.isWaiting) {
      const pausedForSpawns = agent.turnActive ? 0 : agent.backgroundSpawns.size;
      send({
        type: 'agentStatus',
        id,
        status: 'waiting',
        awaitingInput: agent.turnActive || undefined,
        pausedForSpawns: pausedForSpawns || undefined,
        silent: true,
      });
    } else if (agent.turnActive) {
      send({ type: 'agentStatus', id, status: 'active' });
    }

    // 5. Context usage
    if (agent.contextTokens > 0 || agent.contextReported) {
      send({
        type: 'agentContextUsage',
        id,
        contextTokens: agent.contextTokens,
        maxContextTokens: agent.maxContextTokens,
      });
    }

    // 6. Session name and colour (and agent setting)
    const info = agent.sessionInfo;
    if ((info && (info.title || info.color || info.agentSetting)) || agent.remoteHost) {
      send(sessionInfoMessage(id, info ?? {}, agent));
    }
  }
}
