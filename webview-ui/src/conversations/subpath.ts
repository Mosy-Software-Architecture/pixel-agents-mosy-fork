import { CONVERSATION_WHERE_MAX_CHARS } from '../constants.js';

/**
 * Where a conversation runs, under its title. A session that moved below its
 * Directory (a worktree, a subrepo: `Conversation.subpath`) shows that folder
 * relative to the Directory, after the Directory's name where the row shows
 * it (Recent, the search across every Directory) and alone in the
 * Directory's own section. Nothing at all while Show Directory Names is off.
 * A line longer than CONVERSATION_WHERE_MAX_CHARS is shortened, the whole of
 * it kept for the tooltip.
 */

/** A subpath's first and last folders, an ellipsis for those between them
 *  (unchanged with fewer than three folders). */
export function shortSubpath(subpath: string): string {
  const parts = subpath.split('/').filter(Boolean);
  if (parts.length < 3) return subpath;
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}

/** A row's line under its title (`text`) and its tooltip (`title`, the whole
 *  line when it was shortened); undefined when there is nothing to show. The
 *  first that fits: the whole line, the subpath's first and last folders
 *  after the Directory's name, then without the name, then the last folder. */
export function rowWhere(
  directoryName: string | undefined,
  subpath: string | undefined,
  show: boolean,
): { text: string; title?: string } | undefined {
  if (!show) return undefined;
  const name = directoryName || undefined;
  if (!subpath) return name ? { text: name } : undefined;
  const named = (sub: string) => (name ? `${name}/${sub}` : sub);
  const full = named(subpath);
  const last = subpath.split('/').filter(Boolean).pop() ?? subpath;
  const candidates = [full, named(shortSubpath(subpath)), shortSubpath(subpath), `…/${last}`];
  const text = candidates.find((c) => c.length <= CONVERSATION_WHERE_MAX_CHARS) ?? candidates[3];
  return text === full ? { text } : { text, title: full };
}
