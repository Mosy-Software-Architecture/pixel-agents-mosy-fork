import { describe, expect, it } from 'vitest';

import { SESSION_COLORS } from '../src/constants.js';
import {
  agentSessionInfo,
  agentSessionInfoVersion,
  clearAgentSessionInfo,
  remoteHostLabel,
  sessionColor,
  setAgentSessionInfo,
  subscribeAgentSessionInfo,
} from '../src/office/sessionLabel.js';

describe('sessionColor', () => {
  it("tints a session with the colour it was marked with, in the label's readable shade", () => {
    expect(sessionColor('red')).toBe(SESSION_COLORS.red);
    expect(sessionColor('Purple')).toBe(SESSION_COLORS.purple);
  });

  it('leaves a session untinted without a colour, or with one it does not know', () => {
    expect(sessionColor(undefined)).toBeUndefined();
    expect(sessionColor('')).toBeUndefined();
    expect(sessionColor('teal')).toBeUndefined();
    expect(sessionColor('constructor')).toBeUndefined();
  });

  it("covers every colour Claude Code's /color offers", () => {
    for (const name of ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink']) {
      expect(sessionColor(name)).toBeDefined();
    }
  });
});

describe('agent session info', () => {
  it('takes each message as the whole state, and forgets a closed agent', () => {
    setAgentSessionInfo(7, { title: 'lead', color: 'red', agentSetting: 'tools:lead' });
    expect(agentSessionInfo(7)).toEqual({
      title: 'lead',
      color: 'red',
      agentSetting: 'tools:lead',
    });
    // The colour was reset: absent now.
    setAgentSessionInfo(7, { title: 'lead' });
    expect(agentSessionInfo(7)).toEqual({ title: 'lead' });
    setAgentSessionInfo(7, {});
    expect(agentSessionInfo(7)).toBeUndefined();
    setAgentSessionInfo(7, { title: 'again' });
    clearAgentSessionInfo(7);
    expect(agentSessionInfo(7)).toBeUndefined();
  });
});

describe('agent session info subscribers (the agent cards follow renames)', () => {
  it('hears every change, and nothing once unsubscribed', () => {
    let calls = 0;
    const unsubscribe = subscribeAgentSessionInfo(() => calls++);
    const before = agentSessionInfoVersion();
    setAgentSessionInfo(8, { title: 'first' });
    setAgentSessionInfo(8, { title: 'renamed' });
    clearAgentSessionInfo(8);
    // forgetting an agent that has none changes nothing
    clearAgentSessionInfo(8);
    expect(calls).toBe(3);
    expect(agentSessionInfoVersion()).toBe(before + 3);
    unsubscribe();
    setAgentSessionInfo(8, { title: 'again' });
    expect(calls).toBe(3);
    clearAgentSessionInfo(8);
  });
});

describe('the label of a remote session', () => {
  it('says where it runs, and that it is a service there', () => {
    expect(remoteHostLabel({ title: 'lead' })).toBeUndefined();
    expect(remoteHostLabel({ host: 'casita' })).toBe('@casita');
    expect(remoteHostLabel({ host: 'casita', service: true })).toBe('svc @casita');
  });

  it('keeps the service mark only with a host', () => {
    setAgentSessionInfo(9, { title: 'svc-charalanda', host: 'casita', service: true });
    expect(agentSessionInfo(9)).toEqual({ title: 'svc-charalanda', host: 'casita', service: true });
    setAgentSessionInfo(9, { title: 'x', service: true });
    expect(agentSessionInfo(9)).toEqual({ title: 'x' });
    clearAgentSessionInfo(9);
  });
});
