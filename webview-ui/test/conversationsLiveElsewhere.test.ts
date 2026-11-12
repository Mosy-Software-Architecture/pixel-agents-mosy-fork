import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import {
  liveElsewhereBadge,
  liveElsewhereWarning,
  resumeNeedsConfirm,
} from '../src/conversations/liveElsewhere.js';

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  sessionId: 's',
  title: 'lead',
  updatedAt: 1,
  ...extra,
});

describe('a conversation open in another terminal', () => {
  it('asks before resuming it, and only then', () => {
    expect(resumeNeedsConfirm(conversation({ liveElsewhere: { status: 'idle' } }))).toBe(true);
    // Not open anywhere else: one press resumes.
    expect(resumeNeedsConfirm(conversation())).toBe(false);
    // An agent in the office runs it: pressing goes to that agent, no resume.
    expect(resumeNeedsConfirm(conversation({ agentId: 3, liveElsewhere: {} }))).toBe(false);
  });

  it('says what the other terminal is doing when the CLI knows', () => {
    expect(liveElsewhereBadge({ status: 'busy' })).toBe('Open elsewhere · busy');
    expect(liveElsewhereBadge({})).toBe('Open elsewhere');
    expect(liveElsewhereWarning({ status: 'idle' })).toMatch(
      /^Already running in another terminal \(idle\)\. .*second process/,
    );
    expect(liveElsewhereWarning({})).toMatch(/^Already running in another terminal\. /);
  });
});
