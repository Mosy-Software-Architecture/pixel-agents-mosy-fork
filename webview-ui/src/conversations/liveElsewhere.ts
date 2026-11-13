import type { Conversation, LiveElsewhere } from '../../../core/src/messages.js';

/**
 * A conversation whose session runs where the office has no terminal for it:
 * in a terminal the office did not launch (the server's `liveElsewhere`), or
 * through a Headless agent (`headless`). Pressing it resumes it here: the CLI
 * runs a second process on the same session, and a Headless agent takes the
 * new terminal.
 */

/** Whether pressing the row goes to the agent running it (one with a terminal
 *  in the office), rather than resuming it here. */
export function goesToAgent(
  conversation: Conversation,
): conversation is Conversation & { agentId: number } {
  return conversation.agentId !== undefined && !conversation.headless;
}

/** The row's badge: where the session is open, and what it is doing there. */
export function liveElsewhereBadge(live: LiveElsewhere): string {
  return live.status ? `Open elsewhere · ${live.status}` : 'Open elsewhere';
}
