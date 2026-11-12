/**
 * An agent's activity label ("Running: npm test", "Needs approval", "Idle"),
 * the line its card shows under the session's name (AgentCard) and the
 * screen-reader text over its character (ToolOverlay). One reading for both,
 * pure so it runs on the Node test runner.
 */

import type { Character, ToolActivity } from './types.js';

/** The bubble an agent shows: the pending one (office/pendingAck.ts) wins
 *  over the character's own, which fades. */
export type ActivityBubble = 'permission' | 'waiting' | null;

export const NEEDS_APPROVAL_TEXT = 'Needs approval';
/** A turn that ended waiting on the user (Notification(idle_prompt)). A
 *  finished turn (Stop) has no text of its own: the checkmark says it. */
export const WAITING_INPUT_TEXT = 'Waiting for input';
export const IDLE_TEXT = 'Idle';

/** What an agent shows, read from its character and the pending set. */
export interface ActivityState {
  /** Its tools this turn, oldest first. */
  tools: readonly ToolActivity[] | undefined;
  isActive: boolean;
  bubble: ActivityBubble;
  /** With a `waiting` bubble: the agent asked the user something. */
  awaitingInput: boolean;
}

/** What a character shows, given its tools and whether it is pending
 *  (office/pendingAck.ts): a pending bubble holds after the character's own
 *  has faded. A character not in the office yet reads idle. */
export function activityStateOf(
  ch: Pick<Character, 'isActive' | 'bubbleType' | 'waitingAwaitingInput'> | undefined,
  tools: readonly ToolActivity[] | undefined,
  pending: ActivityBubble | undefined,
): ActivityState {
  return {
    tools,
    isActive: ch?.isActive ?? false,
    bubble: pending ?? ch?.bubbleType ?? null,
    awaitingInput: ch?.waitingAwaitingInput ?? false,
  };
}

/** The newest tool still running, if any. */
export function runningTool(tools: readonly ToolActivity[] | undefined): ToolActivity | undefined {
  return tools ? [...tools].reverse().find((t) => !t.done) : undefined;
}

/** A short human-readable activity line. */
export function activityText({ tools, isActive, bubble, awaitingInput }: ActivityState): string {
  if (bubble === 'permission') return NEEDS_APPROVAL_TEXT;
  if (bubble === 'waiting' && awaitingInput) return WAITING_INPUT_TEXT;

  const active = runningTool(tools);
  if (active) return active.permissionWait ? NEEDS_APPROVAL_TEXT : active.status;
  // Every tool done but the turn goes on: keep the last tool's line.
  if (isActive && tools && tools.length > 0) return tools[tools.length - 1].status;
  return IDLE_TEXT;
}
