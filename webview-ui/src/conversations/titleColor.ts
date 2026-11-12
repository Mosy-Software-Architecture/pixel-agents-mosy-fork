import type { Conversation } from '../../../core/src/messages.js';
import { sessionColor } from '../office/sessionLabel.js';

/**
 * The colour a conversation row's title is drawn in: its session's /color,
 * in the shade the label over the character uses (sessionColor), so a red
 * session is the same red in the office and in every list (Recent, a
 * Directory's section, search results). Undefined, the title keeps the row's
 * own colour: no colour set, or one the office doesn't know.
 */
export function conversationTitleColor(
  conversation: Pick<Conversation, 'color'>,
): string | undefined {
  return sessionColor(conversation.color);
}
