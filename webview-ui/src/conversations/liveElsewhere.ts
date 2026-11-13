import type { Conversation, LiveElsewhere } from '../../../core/src/messages.js';

/**
 * A conversation whose session runs where the office has no terminal for it:
 * in a terminal the office did not launch (the server's `liveElsewhere`), or
 * through a Headless agent (`headless`), or in the CLI's background service
 * (`liveElsewhere.kind: 'background'`). Pressing it opens it here: the CLI
 * runs a second process on the same session (a background one is attached to
 * instead, the server decides), and a Headless agent takes the new terminal.
 */

/** Whether pressing the row goes to the agent running it (one with a terminal
 *  in the office), rather than resuming it here. */
export function goesToAgent(
  conversation: Conversation,
): conversation is Conversation & { agentId: number } {
  return conversation.agentId !== undefined && !conversation.headless;
}

/** The row's badge: where the session is open, and what it is doing there.
 *  A background session (no terminal, Claude Code's `claude --bg`) says so,
 *  with its state when it waits for the user (`blocked`), else its status. */
export function liveElsewhereBadge(live: LiveElsewhere): string {
  if (live.kind === 'background') {
    const doing = live.state === BLOCKED_STATE ? live.state : (live.status ?? live.state);
    return doing ? `Background · ${doing}` : 'Background';
  }
  return live.status ? `Open elsewhere · ${live.status}` : 'Open elsewhere';
}

/** The badge's tooltip: where the session runs, under which name, and what
 *  opening it does. */
export function liveElsewhereTitle(live: LiveElsewhere): string {
  if (live.kind === 'background') {
    const as = live.name ? ` as "${live.name}"` : '';
    const id = live.backgroundId ? ` (claude attach ${live.backgroundId})` : '';
    return `Running in the background${as}: opening it attaches${id}`;
  }
  return live.name ? `Open in another terminal as "${live.name}"` : 'Open in another terminal';
}

/** The background state of a session that waits for the user. */
const BLOCKED_STATE = 'blocked';
