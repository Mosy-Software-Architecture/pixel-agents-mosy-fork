import type { Conversation, RemoteHostConversations } from '../../../core/src/messages.js';

/**
 * The sidebar's remote hosts (conversationsLoaded.remoteHosts): each host's
 * sessions under its name, a row like a local conversation's but marked with
 * a small house where a running one has its status dot. Services (a `svc-`
 * name, `remoteKind: 'service'`) follow in a Services group, marked with a
 * gear; pressing one attaches to its tmux, so one outside tmux can't be.
 */

/** Whether a remote row is a service. */
export function isService(conversation: Conversation): boolean {
  return conversation.remoteKind === 'service';
}

/** A host's rows split into its work sessions and its services. */
export function remoteGroups(host: RemoteHostConversations): {
  work: Conversation[];
  services: Conversation[];
} {
  return {
    work: host.conversations.filter((c) => !isService(c)),
    services: host.conversations.filter(isService),
  };
}

/** Whether pressing a remote row does anything: a service runs outside tmux
 *  (the server says so with liveElsewhere) has nothing to attach to. */
export function remoteCanOpen(conversation: Conversation): boolean {
  return (
    conversation.agentId !== undefined ||
    !isService(conversation) ||
    conversation.liveElsewhere === undefined
  );
}

/** What a remote session is doing, in the CLI's words, as the office's
 *  status: busy is working, waiting needs the user, anything else is idle. */
export function remoteActivity(status: string): 'working' | 'attention' | 'idle' {
  if (status === 'busy') return 'working';
  if (status === 'waiting') return 'attention';
  return 'idle';
}

/** What a row shows at its end instead of the time: an agent in the office
 *  runs it (its card's status, else the host's), or it runs on its host (the
 *  host's word for it). The icon is the round dot, or on a remote host's row
 *  the house (the gear for a service). Null: it runs nowhere, and the time
 *  shows. */
export function rowMark<Status extends string>(
  conversation: Conversation,
  remote: boolean,
  statusFor: (agentId: number) => Status | null,
): {
  icon: 'dot' | 'remote' | 'service';
  status: Status | ReturnType<typeof remoteActivity> | null;
} | null {
  const icon = !remote ? 'dot' : isService(conversation) ? 'service' : 'remote';
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
  if (conversation.agentId !== undefined) return `Go to "${conversation.title}"`;
  if (!isService(conversation)) return `Open "${conversation.title}" on ${host}`;
  return remoteCanOpen(conversation)
    ? `Attach to service "${conversation.title}" on ${host}`
    : `Service "${conversation.title}" runs outside tmux on ${host}: nothing to attach to`;
}
