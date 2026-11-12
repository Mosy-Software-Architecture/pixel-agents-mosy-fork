import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import { cardTitleLines } from '../src/components/cardBar.js';
import {
  remoteActivity,
  remoteHostNote,
  remoteRowTitle,
  rowMark,
} from '../src/conversations/remote.js';

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  sessionId: 's',
  title: 'mos-884-outreach',
  updatedAt: 1,
  ...extra,
});

const statusFor = (id: number): 'attention' | null => (id === 7 ? 'attention' : null);

describe("a remote host's rows", () => {
  it("say what the host's session is doing in the office's words", () => {
    expect(remoteActivity('busy')).toBe('working');
    expect(remoteActivity('waiting')).toBe('attention');
    expect(remoteActivity('idle')).toBe('idle');
    expect(remoteActivity('running')).toBe('idle');
  });

  it('mark a running session with the house, coloured by its status', () => {
    // Running on the host.
    expect(rowMark(conversation({ remoteStatus: 'busy' }), true, statusFor)).toEqual({
      icon: 'remote',
      status: 'working',
    });
    // Open in the office: its agent's status wins.
    expect(rowMark(conversation({ agentId: 7, remoteStatus: 'idle' }), true, statusFor)).toEqual({
      icon: 'remote',
      status: 'attention',
    });
    // Running nowhere: the time shows.
    expect(rowMark(conversation(), true, statusFor)).toBeNull();
  });

  it('leave local rows as they were: the dot, and no remote status', () => {
    expect(rowMark(conversation({ agentId: 7 }), false, statusFor)).toEqual({
      icon: 'dot',
      status: 'attention',
    });
    expect(rowMark(conversation({ remoteStatus: 'busy' }), false, statusFor)).toBeNull();
  });

  it('say why a host lists nothing', () => {
    expect(remoteHostNote({ name: 'casita', online: false, conversations: [] })).toBe('Offline');
    expect(remoteHostNote({ name: 'casita', online: true, conversations: [] })).toBe('No sessions');
    expect(
      remoteHostNote({ name: 'casita', online: true, conversations: [conversation()] }),
    ).toBeNull();
  });

  it('name the host in the tooltip of one to open', () => {
    expect(remoteRowTitle(conversation(), 'casita')).toBe('Open "mos-884-outreach" on casita');
    expect(remoteRowTitle(conversation({ agentId: 7 }), 'casita')).toBe('Go to "mos-884-outreach"');
  });

  it("put the host on its agent card's tooltip", () => {
    expect(cardTitleLines({ agentId: 3, sessionTitle: 'outreach', host: 'casita' })).toEqual([
      'outreach',
      'on casita',
    ]);
  });
});
