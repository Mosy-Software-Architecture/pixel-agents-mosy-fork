import type { Conversation, DirectoryConversations } from '../../../core/src/messages.js';

/** A conversation with the Directory it was listed under (a resume needs its path). */
export interface PlacedConversation {
  conversation: Conversation;
  directory: DirectoryConversations;
}

/**
 * The `count` newest conversations across every Directory. The server lists
 * each Directory's newest, so the newest overall are always among them: no
 * second request needed.
 */
export function recentAcross(
  directories: readonly DirectoryConversations[],
  count: number,
): PlacedConversation[] {
  return directories
    .flatMap((directory) =>
      directory.conversations.map((conversation) => ({ conversation, directory })),
    )
    .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt)
    .slice(0, count);
}

/**
 * What the sidebar's Recent section lists. With one Directory, Recent stands
 * in for its section (no "By Directory" block, it would repeat Recent): every
 * conversation the server sent for it, and `more` when older ones exist, so
 * Recent gets that section's "Show 5 more". With several, the `count` newest
 * across every Directory, and a section per Directory below.
 */
export function recentSection(
  directories: readonly DirectoryConversations[],
  count: number,
): { rows: PlacedConversation[]; more: boolean; byDirectory: boolean } {
  if (directories.length === 1) {
    return {
      rows: recentAcross(directories, Infinity),
      more: directories[0].more === true,
      byDirectory: false,
    };
  }
  return { rows: recentAcross(directories, count), more: false, byDirectory: true };
}

/** How many conversations the lists left out because they are done (each
 *  Directory's `doneHidden`): the search still lists them, so "See all"
 *  stays offered while any exist, even with no row shown. */
export function doneHiddenCount(directories: readonly DirectoryConversations[]): number {
  return directories.reduce((sum, directory) => sum + (directory.doneHidden ?? 0), 0);
}
