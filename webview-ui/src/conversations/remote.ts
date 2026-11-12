import type { Conversation, RemoteHostConversations } from '../../../core/src/messages.js';

/**
 * The sidebar's remote hosts (conversationsLoaded.remoteHosts): each host's
 * sessions under its name, a row like a local conversation's but marked with
 * a small house where a running one has its status dot.
 */

/** What a remote session is doing, in the CLI's words, as the office's
 *  status: busy is working, waiting needs the user, anything else is idle. */
export function remoteActivity(status: string): 'working' | 'attention' | 'idle' {
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'attention';
  return 'idle';
}

/** What a row shows at its end instead of the time: an agent in the office
 *  runs it (its card's status, else the host's), or it runs on its host (the
 *  host's word for it). The icon is the round dot, or the house on a remote host's row. Null:
 *  it runs nowhere, and the time shows. */
export function rowMark<Status extends string>(
  conversation: Conversation,
  remote: boolean,
  statusFor: (agentId: number) => Status | null,
): { icon: 'dot' | 'remote'; status: Status | ReturnType<typeof remoteActivity> | null } | null {
  const icon = remote ? 'remote' : 'dot';
  const onHost =
    remote && conversation.remoteStatus ? remoteActivity(conversation.remoteStatus) : null;
  if (conversation.agentId !== undefined) {
    // Its agent's status, once the office knows one.
    return { icon, status: statusFor(conversation.agentId) ?? onHost };
  }
  return onHost ? { icon, status: onHost } : null;
}

/** The line a host's section shows in place of its rows, or null. */
export function remoteHostNote(host: RemoteHostConversations): string | null {
  if (!host.online) return 'Offline';
  return host.conversations.length === 0 ? 'No sessions' : null;
}

/** A remote row's tooltip. */
export function remoteRowTitle(conversation: Conversation, host: string): string {
  return conversation.agentId !== undefined
    ? `Go to "${conversation.title}"`
    : `Open "${conversation.title}" on ${host}`;
}
