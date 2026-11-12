/**
 * An agent's activity label ("Running: npm test", "Needs approval", "Idle"),
 * the line its card shows under the session's name (AgentCard) and the
 * screen-reader text over its character (ToolOverlay). One reading for both,
 * pure so it runs on the Node test runner.
 */

import { extractToolName } from './toolUtils.js';
import type { Character, ToolActivity } from './types.js';

/** The bubble an agent shows: the pending one (office/pendingAck.ts) wins
 *  over the character's own, which fades. */
export type ActivityBubble = 'permission' | 'waiting' | null;

export const NEEDS_APPROVAL_TEXT = 'Needs approval';
/** The agent asked the user something (AskUserQuestion, ExitPlanMode) and
 *  waits for the answer. A finished turn (Stop) has no text of its own: the
 *  checkmark says it. */
export const WAITING_INPUT_TEXT = 'Waiting for input';
export const IDLE_TEXT = 'Idle';

/** A lead that ended its turn to wait on its background agents. */
export function waitingOnSpawnsText(count: number): string {
  return `Waiting on ${count} background agent${count === 1 ? '' : 's'}`;
}

/** What an agent shows, read from its character and the pending set. */
export interface ActivityState {
  /** Its tools this turn, oldest first. */
  tools: readonly ToolActivity[] | undefined;
  isActive: boolean;
  bubble: ActivityBubble;
  /** With a `waiting` bubble: the agent asked the user something. */
  awaitingInput: boolean;
  /** Its turn ended while this many background agents it spawned still run. */
  pausedForSpawns?: number;
}

/** What a character shows, given its tools and whether it is pending
 *  (office/pendingAck.ts): a pending bubble holds after the character's own
 *  has faded. A character not in the office yet reads idle. */
export function activityStateOf(
  ch:
    | Pick<Character, 'isActive' | 'bubbleType' | 'waitingAwaitingInput' | 'pausedForSpawns'>
    | undefined,
  tools: readonly ToolActivity[] | undefined,
  pending: ActivityBubble | undefined,
): ActivityState {
  return {
    tools,
    isActive: ch?.isActive ?? false,
    bubble: pending ?? ch?.bubbleType ?? null,
    awaitingInput: ch?.waitingAwaitingInput ?? false,
    pausedForSpawns: ch?.pausedForSpawns,
  };
}

/** The newest tool still running, if any. */
export function runningTool(tools: readonly ToolActivity[] | undefined): ToolActivity | undefined {
  return tools ? [...tools].reverse().find((t) => !t.done) : undefined;
}

/** Tools that ask the user something: once answered, the agent is thinking
 *  about the answer, not still asking. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** The turn's latest tool, running or done (the tools are cleared when a
 *  turn ends or starts, so during a turn it is what the agent did last).
 *  None after an answered question. */
export function lastTool(tools: readonly ToolActivity[] | undefined): ToolActivity | undefined {
  const last = tools && tools.length > 0 ? tools[tools.length - 1] : undefined;
  if (last?.done && QUESTION_TOOLS.has(extractToolName(last.status) ?? '')) return undefined;
  return last;
}

/** A short human-readable activity line. */
export function activityText({
  tools,
  isActive,
  bubble,
  awaitingInput,
  pausedForSpawns,
}: ActivityState): string {
  if (bubble === 'permission') return NEEDS_APPROVAL_TEXT;
  if (bubble === 'waiting' && awaitingInput) return WAITING_INPUT_TEXT;
  // Before the running tools: its spawns' rows still run.
  if (pausedForSpawns) return waitingOnSpawnsText(pausedForSpawns);

  const active = runningTool(tools);
  if (active) return active.permissionWait ? NEEDS_APPROVAL_TEXT : active.status;
  // Every tool done but the turn goes on: keep the last tool's line (the
  // icon keeps its icon, office/activityIcon.ts).
  const last = isActive ? lastTool(tools) : undefined;
  return last ? last.status : IDLE_TEXT;
}
