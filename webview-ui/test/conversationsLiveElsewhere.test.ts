import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import {
  goesToAgent,
  liveElsewhereBadge,
  liveElsewhereTitle,
} from '../src/conversations/liveElsewhere.js';

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

  it('names a background session, with what it is doing and what opening it does', () => {
    expect(liveElsewhereBadge({ kind: 'background', status: 'idle', state: 'working' })).toBe(
      'Background · idle',
    );
    // Waiting for the user beats the worker's own status.
    expect(liveElsewhereBadge({ kind: 'background', status: 'idle', state: 'blocked' })).toBe(
      'Background · blocked',
    );
    // A job whose worker is not running has only a state.
    expect(liveElsewhereBadge({ kind: 'background', state: 'working' })).toBe(
      'Background · working',
    );
    expect(liveElsewhereBadge({ kind: 'background' })).toBe('Background');
    expect(
      liveElsewhereTitle({ kind: 'background', name: 'surv1', backgroundId: '095e9c03' }),
    ).toBe('Running in the background as "surv1": opening it attaches (claude attach 095e9c03)');
    expect(liveElsewhereTitle({ name: 'lead' })).toBe('Open in another terminal as "lead"');
  });
});
