import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import { cardTitleLines } from '../src/components/cardBar.js';
import { ICONS } from '../src/components/ui/pixelIcons.js';
import {
  remoteActivity,
  remoteCanOpen,
  remoteGroups,
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
    // Open, its agent's status not known yet: the host's.
    expect(rowMark(conversation({ agentId: 3, remoteStatus: 'busy' }), true, statusFor)).toEqual({
      icon: 'remote',
      status: 'working',
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
    expect(
      cardTitleLines({ agentId: 3, sessionTitle: 'svc-charalanda', host: 'casita', service: true }),
    ).toEqual(['svc-charalanda', 'service on casita']);
  });
});

describe("a remote host's services", () => {
  const service = (extra: Partial<Conversation> = {}) =>
    conversation({
      title: 'svc-charalanda',
      remoteKind: 'service',
      remoteStatus: 'idle',
      ...extra,
    });

  it('come in their own group, after the work sessions', () => {
    const work = conversation({ sessionId: 'w', remoteKind: 'work' });
    const svc = service({ sessionId: 'v' });
    expect(remoteGroups({ name: 'casita', online: true, conversations: [svc, work] })).toEqual({
      work: [work],
      services: [svc],
    });
  });

  it('are marked with the gear, coloured by status', () => {
    expect(rowMark(service({ remoteStatus: 'busy' }), true, statusFor)).toEqual({
      icon: 'service',
      status: 'working',
    });
    expect(rowMark(service({ agentId: 7 }), true, statusFor)).toEqual({
      icon: 'service',
      status: 'attention',
    });
  });

  it('draw the gear as an 8x8 icon like the house', () => {
    expect(ICONS.service).toHaveLength(8);
    for (const line of ICONS.service) expect(line).toHaveLength(8);
  });

  it('attach when in tmux, and say why one outside tmux cannot be opened', () => {
    expect(remoteCanOpen(service())).toBe(true);
    expect(remoteRowTitle(service(), 'casita')).toBe(
      'Attach to service "svc-charalanda" on casita',
    );
    const outside = service({ liveElsewhere: { name: 'svc-charalanda', status: 'idle' } });
    expect(remoteCanOpen(outside)).toBe(false);
    expect(remoteRowTitle(outside, 'casita')).toBe(
      'Service "svc-charalanda" runs outside tmux on casita: nothing to attach to',
    );
    // Open in the office already: it can be gone to.
    expect(remoteCanOpen({ ...outside, agentId: 7 })).toBe(true);
    // A work session outside tmux still opens (it asks first, then resumes).
    expect(remoteCanOpen(conversation({ liveElsewhere: {} }))).toBe(true);
  });
});
