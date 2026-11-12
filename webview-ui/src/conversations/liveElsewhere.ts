import type { Conversation, LiveElsewhere } from '../../../core/src/messages.js';

/**
 * A conversation still open in a terminal the office did not launch (the
 * server's `liveElsewhere`): resuming it here would run a second process on
 * the same session, so the list asks first.
 */

/** Whether pressing the row must ask before resuming: it would resume (no
 *  agent in the office runs it) a session that is open elsewhere. */
export function resumeNeedsConfirm(conversation: Conversation): boolean {
  return conversation.agentId === undefined && conversation.liveElsewhere !== undefined;
}

/** The row's badge: where the session is open, and what it is doing there. */
export function liveElsewhereBadge(live: LiveElsewhere): string {
  return live.status ? `Open elsewhere · ${live.status}` : 'Open elsewhere';
}

/** The confirmation's explanation. */
export function liveElsewhereWarning(live: LiveElsewhere): string {
  const status = live.status ? ` (${live.status})` : '';
  return (
    `Already running in another terminal${status}. ` +
    'Resuming it here starts a second process on the same session.'
  );
}
