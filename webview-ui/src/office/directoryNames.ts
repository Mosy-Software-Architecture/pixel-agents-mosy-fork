/**
 * Whether an agent's Directory name shows (Settings → Show Directory Names,
 * settingsLoaded.showDirectoryNames): under each Recent conversation and
 * search result, and as the last line of the label over its character. On by
 * default; off suits a host whose sessions all live in one Directory, where
 * the name says nothing. Kept outside React, like the session names, so the
 * label (ToolOverlay) and the rows read one value without threading a prop
 * through every list.
 */

let shown = true;
const listeners = new Set<() => void>();

export function showDirectoryNames(): boolean {
  return shown;
}

export function setShowDirectoryNames(next: boolean): void {
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

export function subscribeShowDirectoryNames(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Directory name to show under a row or a label: none while names are hidden. */
export function shownDirectoryName(name: string | undefined, show: boolean): string | undefined {
  return show ? name || undefined : undefined;
}
