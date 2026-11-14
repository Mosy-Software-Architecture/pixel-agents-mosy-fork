import { afterEach, describe, expect, it } from 'vitest';

import type { Conversation, DirectoryConversations } from '../../core/src/messages.js';
import { markMode, markTitle } from '../src/components/cardBar.js';
import { doneHiddenCount, recentSection } from '../src/conversations/recent.js';
import { remotePage, remoteSearch } from '../src/conversations/remote.js';
import { sessionMarkOf, setSessionMarks } from '../src/office/sessionMarks.js';

/**
 * Done marks in the office: the card's check (who gets one, button or badge,
 * when it shows), the marks store, and the sidebar's hiding (the server
 * leaves done conversations out of a Directory's list and counts them in
 * `doneHidden`; a remote host's listing is filtered here).
 */

const conversation = (n: number, extra: Partial<Conversation> = {}): Conversation => ({
  sessionId: `s${n}`,
  title: `Task ${n}`,
  updatedAt: 100 - n,
  ...extra,
});

describe('markMode: the card check', () => {
  const local = { done: false };
  const done = { done: true };

  it('a button following the × on a session not done', () => {
    expect(markMode('hover', { mark: local, canMark: true, showLabel: true })).toBe('hover');
    expect(markMode('hidden', { mark: local, canMark: true, showLabel: false })).toBe('hidden');
  });

  it('done: the desktop label has the check, so the button still follows the ×; the phone keeps it shown', () => {
    expect(markMode('hover', { mark: done, canMark: true, showLabel: true })).toBe('hover');
    expect(markMode('hidden', { mark: done, canMark: true, showLabel: false })).toBe('shown');
  });

  it('no button where the office may not mark, or on a remote session: a badge when done on the phone', () => {
    expect(markMode('hover', { mark: local, canMark: false, showLabel: false })).toBe(null);
    expect(markMode('hover', { mark: done, canMark: false, showLabel: false })).toBe('badge');
    expect(markMode('hover', { mark: done, canMark: false, showLabel: true })).toBe(null);
    expect(
      markMode('hover', { mark: { done: true, remote: true }, canMark: true, showLabel: false }),
    ).toBe('badge');
  });

  it('nothing for an agent the server listed no session for', () => {
    expect(markMode('shown', { mark: undefined, canMark: true, showLabel: true })).toBe(null);
  });

  it('says what a press does', () => {
    expect(markTitle(false)).toBe('Mark as done');
    expect(markTitle(true)).toMatch(/take the mark off/);
  });
});

describe('the marks store', () => {
  afterEach(() => setSessionMarks({}));

  it('keeps the server map, whole each time', () => {
    setSessionMarks({ 1: { sessionId: 'a', done: true }, 2: { sessionId: 'b' } });
    expect(sessionMarkOf(1)).toEqual({ sessionId: 'a', done: true });
    setSessionMarks({ 2: { sessionId: 'b' } });
    expect(sessionMarkOf(1)).toBeUndefined();
    expect(sessionMarkOf(2)?.done).toBeUndefined();
  });
});

describe('the sidebar hides done conversations', () => {
  const dir = (extra: Partial<DirectoryConversations>): DirectoryConversations => ({
    name: 'Web',
    path: '/web',
    conversations: [],
    ...extra,
  });

  it('counts what the server left out, so "See all" stays offered', () => {
    expect(doneHiddenCount([dir({ doneHidden: 2 }), dir({ path: '/api' })])).toBe(2);
    expect(doneHiddenCount([dir({})])).toBe(0);
    // Recent lists only what the server sent (no done rows).
    expect(
      recentSection([dir({ conversations: [conversation(1)], doneHidden: 3 })], 5).rows,
    ).toHaveLength(1);
  });

  it("pages a remote host's sessions without its done ones, which its search still finds", () => {
    const host = {
      name: 'casita',
      online: true,
      conversations: [
        conversation(1, { done: true }),
        ...[2, 3, 4, 5, 6, 7].map((n) => conversation(n)),
      ],
    };
    const page = remotePage(host);
    expect(page.work.map((c) => c.title)).toEqual([
      'Task 2',
      'Task 3',
      'Task 4',
      'Task 5',
      'Task 6',
    ]);
    expect(page.moreWork).toBe(true);
    expect(page.doneHidden).toBe(1);
    expect(remoteSearch(host, 'task 1').map((c) => c.done)).toEqual([true]);
  });

  it('a host with only done sessions shows none and still says how many', () => {
    const page = remotePage({
      name: 'h',
      online: true,
      conversations: [conversation(1, { done: true })],
    });
    expect(page.work).toEqual([]);
    expect(page.moreWork).toBe(false);
    expect(page.doneHidden).toBe(1);
  });
});
