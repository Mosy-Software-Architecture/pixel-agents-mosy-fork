/**
 * The office's one-line notices (NoticeToast): what the user should know
 * about something they pressed that did not do what it usually does — a
 * conversation already running in another terminal, a session the skull
 * could not stop, a skull waiting for its second press. One at a time, the
 * newest wins, each gone after NOTICE_SHOW_MS. Kept outside React like
 * backgroundSessions.ts: the toast reads it with useSyncExternalStore.
 */

import { NOTICE_SHOW_MS } from '../constants.js';

export interface Notice {
  text: string;
  /** Tells notices with the same text apart (a repeat shows again). */
  seq: number;
}

let current: Notice | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The notice showing now, or null. */
export function currentNotice(): Notice | null {
  return current;
}

/** Show `text` for `ms` (replacing whatever showed). */
export function showNotice(text: string, ms: number = NOTICE_SHOW_MS): void {
  clearTimeout(timer);
  const notice = { text, seq: ++seq };
  current = notice;
  timer = setTimeout(() => {
    if (current === notice) {
      current = null;
      changed();
    }
  }, ms);
  changed();
}

/** Take the notice away (pressed). */
export function dismissNotice(): void {
  clearTimeout(timer);
  if (current === null) return;
  current = null;
  changed();
}
