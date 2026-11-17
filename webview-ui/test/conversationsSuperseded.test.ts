import { describe, expect, it } from 'vitest';

import type { Conversation, DirectoryConversations } from '../../core/src/messages.js';
import { doneHiddenCount } from '../src/conversations/recent.js';
import { rowPress, supersededLabel, supersededTitle } from '../src/conversations/superseded.js';

/** A conversation a /clear left behind (MOS-947): labelled, never resumed. */

const NEW = 'd81f976a-9183-44b8-8591-dfab31583fa0';
const old = (superseded: Conversation['superseded']): Conversation => ({
  sessionId: '7f783b00-21a5-4258-bbee-4c9f88f67762',
  title: 'lead',
  updatedAt: 1,
  superseded,
});

describe('superseded conversations', () => {
  it('say where they continue, by short id', () => {
    expect(supersededLabel({ sessionId: NEW })).toBe('cleared → continues in d81f976a');
    expect(supersededTitle({ sessionId: NEW, inferred: true })).toContain('inferred');
  });

  it('pressing one goes to the agent running what continues it, or does nothing', () => {
    expect(rowPress(old({ sessionId: NEW, agentId: 4 }), false)).toEqual({
      kind: 'agent',
      agentId: 4,
    });
    expect(rowPress(old({ sessionId: NEW }), false)).toEqual({ kind: 'none' });
  });

  it('any other row goes to its agent or resumes', () => {
    expect(rowPress({ ...old(undefined), agentId: 2 }, true)).toEqual({
      kind: 'agent',
      agentId: 2,
    });
    expect(rowPress(old(undefined), false)).toEqual({ kind: 'resume' });
  });

  it('the ones the lists left out keep "See all" offered', () => {
    const dir: DirectoryConversations = {
      name: 'w',
      path: '/w',
      conversations: [],
      supersededHidden: 2,
      doneHidden: 1,
    };
    expect(doneHiddenCount([dir])).toBe(3);
  });
});
