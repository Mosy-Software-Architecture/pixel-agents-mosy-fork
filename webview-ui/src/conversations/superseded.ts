import type { Conversation } from '../../../core/src/messages.js';
import { SUPERSEDED_SHORT_ID_CHARS } from '../constants.js';

/**
 * A superseded conversation (Conversation.superseded): a `/clear` left its
 * session behind and another session continues it. It is no agent of its
 * own: the lists leave it out, the search labels it, and pressing it goes to
 * the agent running what continues it, never resuming anything.
 */

/** The label under its title: where it continues. */
export function supersededLabel(superseded: NonNullable<Conversation['superseded']>): string {
  return `cleared → continues in ${superseded.sessionId.slice(0, SUPERSEDED_SHORT_ID_CHARS)}`;
}

/** The label's tooltip. */
export function supersededTitle(superseded: NonNullable<Conversation['superseded']>): string {
  const how = superseded.inferred ? ' (inferred from the transcripts)' : '';
  const go =
    superseded.agentId !== undefined
      ? 'pressing it goes to the agent running it'
      : 'no agent in the office runs it';
  return `/clear left this session behind; it continues as ${superseded.sessionId}${how}: ${go}`;
}

/** What pressing a conversation does: go to an agent, resume it, or nothing
 *  (a superseded one whose continuation no agent runs). */
export type RowPress = { kind: 'agent'; agentId: number } | { kind: 'resume' } | { kind: 'none' };

export function rowPress(conversation: Conversation, goesToAgent: boolean): RowPress {
  const { superseded } = conversation;
  if (superseded) {
    return superseded.agentId !== undefined
      ? { kind: 'agent', agentId: superseded.agentId }
      : { kind: 'none' };
  }
  if (goesToAgent && conversation.agentId !== undefined) {
    return { kind: 'agent', agentId: conversation.agentId };
  }
  return { kind: 'resume' };
}
