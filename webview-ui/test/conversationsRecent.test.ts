import { describe, expect, it } from 'vitest';

import type { DirectoryConversations } from '../../core/src/messages.js';
import { recentAcross, recentSection } from '../src/conversations/recent.js';

const dir = (name: string, times: number[]): DirectoryConversations => ({
  name,
  path: `/${name}`,
  conversations: times.map((t) => ({
    sessionId: `${name}-${t}`,
    title: `${name} ${t}`,
    updatedAt: t,
  })),
});

describe('recentAcross', () => {
  it('takes the newest across Directories, each with its Directory', () => {
    const recent = recentAcross([dir('a', [9, 4, 1]), dir('b', [8, 7, 2]), dir('c', [])], 4);
    expect(recent.map((r) => r.conversation.sessionId)).toEqual(['a-9', 'b-8', 'b-7', 'a-4']);
    expect(recent[1].directory.path).toBe('/b');
  });

  it('returns fewer when there are fewer', () => {
    expect(recentAcross([dir('a', [3])], 5)).toHaveLength(1);
    expect(recentAcross([], 5)).toEqual([]);
  });
});

describe('recentSection', () => {
  it('with one Directory, lists all it was sent and takes its "Show 5 more", no By Directory', () => {
    const only = { ...dir('a', [9, 8, 7, 6, 5]), more: true };
    const section = recentSection([only], 5);
    expect(section.byDirectory).toBe(false);
    expect(section.more).toBe(true);
    expect(section.rows).toHaveLength(5);
    // After "Show 5 more" the server sends ten: Recent lists all ten.
    const raised = dir('a', [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const after = recentSection([raised], 5);
    expect(after.rows).toHaveLength(10);
    expect(after.more).toBe(false);
  });

  it('with several, the newest across them and a section per Directory', () => {
    const section = recentSection([{ ...dir('a', [9, 4, 1]), more: true }, dir('b', [8, 7, 2])], 4);
    expect(section.byDirectory).toBe(true);
    expect(section.more).toBe(false);
    expect(section.rows.map((r) => r.conversation.sessionId)).toEqual(['a-9', 'b-8', 'b-7', 'a-4']);
  });
});
