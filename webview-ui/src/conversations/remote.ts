import type { Conversation, RemoteHostConversations } from '../../../core/src/messages.js';
import { CONVERSATIONS_PER_DIRECTORY, CONVERSATIONS_SHOW_MORE_STEP } from '../constants.js';

/**
 * The sidebar's remote hosts (conversationsLoaded.remoteHosts): each host's
 * sessions under its name, a row like a local conversation's but marked with
 * a small house where a running one has its status dot. Services (a `svc-`
 * name, `remoteKind: 'service'`) follow in a Services group, marked with a
 * gear; pressing one attaches to its tmux, so one outside tmux can't be.
 * Each group pages like a Directory: five rows, then "Show 5 more".
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

/** How many rows of a host's groups show, where not the default five
 *  (CONVERSATIONS_PER_DIRECTORY): raised by "Show 5 more", forgotten on
 *  reload and whenever a Directory section opens or shuts. */
export interface RemoteShown {
  work?: number;
  services?: number;
}

/** A host's groups as the sidebar shows them: the first `shown` of each, and
 *  whether more are behind a "Show 5 more". Sessions marked done on the host
 *  are left out of both (and of the counts): its search lists them
 *  (remoteSearch); `doneHidden` says how many. */
export function remotePage(
  host: RemoteHostConversations,
  shown: RemoteShown = {},
): {
  work: Conversation[];
  services: Conversation[];
  moreWork: boolean;
  moreServices: boolean;
  doneHidden: number;
} {
  const all = remoteGroups(host);
  const groups = {
    work: all.work.filter((c) => !c.done),
    services: all.services.filter((c) => !c.done),
  };
  const work = shown.work ?? CONVERSATIONS_PER_DIRECTORY;
  const services = shown.services ?? CONVERSATIONS_PER_DIRECTORY;
  return {
    work: groups.work.slice(0, work),
    services: groups.services.slice(0, services),
    moreWork: groups.work.length > work,
    moreServices: groups.services.length > services,
    doneHidden: host.conversations.length - groups.work.length - groups.services.length,
  };
}

/** `shown` after a group's "Show 5 more". */
export function remoteShowMore(shown: RemoteShown, group: keyof RemoteShown): RemoteShown {
  return {
    ...shown,
    [group]: (shown[group] ?? CONVERSATIONS_PER_DIRECTORY) + CONVERSATIONS_SHOW_MORE_STEP,
  };
}

/** A host's rows whose title holds every word of `query` (any case), in the
 *  sidebar's order: the search scoped to a host (the server's titleMatches,
 *  run over the listing the sidebar already holds). Done ones included. */
export function remoteSearch(host: RemoteHostConversations, query: string): Conversation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const { work, services } = remoteGroups(host);
  return [...work, ...services].filter((c) => {
    const title = c.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
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
