import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import { goesToAgent, liveElsewhereBadge } from '../src/conversations/liveElsewhere.js';

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  sessionId: 's',
  title: 'lead',
  updatedAt: 1,
  ...extra,
});

describe('a conversation open in another terminal', () => {
  it('resumes at once, open elsewhere or not', () => {
    expect(goesToAgent(conversation({ liveElsewhere: { status: 'idle' } }))).toBe(false);
    expect(goesToAgent(conversation())).toBe(false);
  });

  it('goes to an agent with a terminal, and resumes into a Headless one', () => {
    expect(goesToAgent(conversation({ agentId: 3, liveElsewhere: {} }))).toBe(true);
    // Its agent has no terminal here: pressing gives it one.
    expect(goesToAgent(conversation({ agentId: 3, headless: true, liveElsewhere: {} }))).toBe(
      false,
    );
  });

  it('says what the other terminal is doing when the CLI knows', () => {
    expect(liveElsewhereBadge({ status: 'busy' })).toBe('Open elsewhere · busy');
    expect(liveElsewhereBadge({})).toBe('Open elsewhere');
  });
});
