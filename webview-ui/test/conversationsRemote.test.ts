import { describe, expect, it } from 'vitest';

import type { Conversation } from '../../core/src/messages.js';
import { cardTitleLines } from '../src/components/cardBar.js';
import { ICONS } from '../src/components/ui/pixelIcons.js';
import {
  remoteActivity,
  remoteCanOpen,
  remoteGroups,
  remoteHostNote,
  remotePage,
  remoteRowTitle,
  remoteSearch,
  remoteShowMore,
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

describe("a remote host's section pages like a Directory", () => {
  const work = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      conversation({ sessionId: `w${i}`, title: `work ${i}`, remoteKind: 'work' }),
    );
  const services = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      conversation({ sessionId: `v${i}`, title: `svc-${i}`, remoteKind: 'service' }),
    );
  const host = (w: number, v: number) => ({
    name: 'casita',
    online: true,
    conversations: [...work(w), ...services(v)],
  });

  it('shows five work rows, then "Show 5 more" while more exist', () => {
    const page = remotePage(host(12, 0));
    expect(page.work.map((c) => c.sessionId)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
    expect(page.moreWork).toBe(true);
    expect(remotePage(host(5, 0)).moreWork).toBe(false);
  });

  it('shows five more per press, until there are none left', () => {
    const once = remoteShowMore({}, 'work');
    expect(once).toEqual({ work: 10 });
    expect(remotePage(host(12, 0), once).work).toHaveLength(10);
    const twice = remoteShowMore(once, 'work');
    const page = remotePage(host(12, 0), twice);
    expect(page.work).toHaveLength(12);
    expect(page.moreWork).toBe(false);
  });

  it('pages the services on their own', () => {
    const page = remotePage(host(3, 7));
    expect(page.work).toHaveLength(3);
    expect(page.moreWork).toBe(false);
    expect(page.services.map((c) => c.sessionId)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
    expect(page.moreServices).toBe(true);
    const more = remoteShowMore({}, 'services');
    expect(more).toEqual({ services: 10 });
    const after = remotePage(host(3, 7), more);
    expect(after.services).toHaveLength(7);
    expect(after.moreServices).toBe(false);
    // The work group is left as it was.
    expect(after.work).toHaveLength(3);
  });
});

describe('the search scoped to a remote host', () => {
  const casita = {
    name: 'casita',
    online: true,
    conversations: [
      conversation({ sessionId: 'a', title: 'MOS-884 outreach', remoteStatus: 'busy' }),
      conversation({ sessionId: 'b', title: 'Fix the panel', remoteKind: 'work' }),
      conversation({ sessionId: 'c', title: 'svc-charalanda', remoteKind: 'service' }),
    ],
  };

  it('lists the whole listing, work then services, with an empty query', () => {
    expect(remoteSearch(casita, '').map((c) => c.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it('matches every word of the query in the title, any case', () => {
    expect(remoteSearch(casita, 'outreach mos').map((c) => c.sessionId)).toEqual(['a']);
    expect(remoteSearch(casita, 'CHARALANDA').map((c) => c.sessionId)).toEqual(['c']);
    expect(remoteSearch(casita, 'nothing')).toEqual([]);
  });

  it('keeps each row as listed, marks and all', () => {
    const [found] = remoteSearch(casita, 'outreach');
    expect(rowMark(found, true, statusFor)).toEqual({ icon: 'remote', status: 'working' });
    const [svc] = remoteSearch(casita, 'svc');
    expect(rowMark({ ...svc, remoteStatus: 'idle' }, true, statusFor)?.icon).toBe('service');
  });
});
