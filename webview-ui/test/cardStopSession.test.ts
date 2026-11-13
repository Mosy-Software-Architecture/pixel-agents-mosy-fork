import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopMode, stopPress, stopTitle } from '../src/components/cardBar.js';
import { STOP_SESSION_ARM_MS, STOP_SESSION_FAILED_SHOW_MS } from '../src/constants.js';
import {
  backgroundSessionOf,
  clearStop,
  pressStop,
  setBackgroundSessions,
  stopFailed,
  stopStateOf,
} from '../src/office/backgroundSessions.js';

describe('stopMode: which cards show the skull', () => {
  it('only an agent whose session runs in the background, where this office may stop it', () => {
    expect(stopMode('hover', { backgroundId: '7fdcf719', canStop: true, phase: undefined })).toBe(
      'hover',
    );
    // An interactive session in another terminal: no skull, never.
    expect(stopMode('hover', { backgroundId: undefined, canStop: true, phase: undefined })).toBe(
      null,
    );
    // A read-only office (or VS Code, which never says who runs in the background).
    expect(stopMode('shown', { backgroundId: '7fdcf719', canStop: false, phase: undefined })).toBe(
      null,
    );
  });

  it('follows the × at rest (the phone shows it only on the active card)', () => {
    const at = (close: 'shown' | 'hover' | 'hidden') =>
      stopMode(close, { backgroundId: '7fdcf719', canStop: true, phase: undefined });
    expect(at('hidden')).toBe('hidden');
    expect(at('shown')).toBe('shown');
  });

  it('stays shown while armed, stopping or failed', () => {
    for (const phase of ['armed', 'stopping', 'failed'] as const) {
      expect(stopMode('hidden', { backgroundId: '7fdcf719', canStop: true, phase })).toBe('shown');
    }
  });
});

describe('stopPress: two presses stop the session', () => {
  it('arms on the first press and sends on the second, once', () => {
    expect(stopPress(undefined)).toEqual({ phase: 'armed', send: false });
    expect(stopPress('armed')).toEqual({ phase: 'stopping', send: true });
    expect(stopPress('stopping')).toEqual({ phase: 'stopping', send: false });
    expect(stopPress('failed')).toEqual({ phase: 'armed', send: false });
  });

  it('says what the next press does', () => {
    expect(stopTitle(undefined, '7fdcf719')).toMatch(/^Stop session/);
    expect(stopTitle('armed', '7fdcf719')).toContain('Press again');
    expect(stopTitle('failed', '7fdcf719', "No job matching '7fdcf719'")).toContain(
      "No job matching '7fdcf719'",
    );
  });
});

describe('the skull store', () => {
  afterEach(() => {
    clearStop(1);
    setBackgroundSessions({});
    vi.useRealTimers();
  });

  it('keeps the server map, whole each time', () => {
    setBackgroundSessions({ 1: '7fdcf719', 2: 'aa0f0459' });
    expect(backgroundSessionOf(1)).toBe('7fdcf719');
    setBackgroundSessions({ 2: 'aa0f0459' });
    expect(backgroundSessionOf(1)).toBeUndefined();
  });

  it('a first press arms for a while; a second within it sends the stop', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    pressStop(1, send);
    expect(stopStateOf(1)?.phase).toBe('armed');
    vi.advanceTimersByTime(STOP_SESSION_ARM_MS + 1);
    expect(stopStateOf(1)).toBeUndefined();

    pressStop(1, send);
    pressStop(1, send);
    pressStop(1, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(1);
    expect(stopStateOf(1)?.phase).toBe('stopping');
  });

  it('a failed stop shows its reason for a while, then rests', () => {
    vi.useFakeTimers();
    stopFailed(1, 'claude stop timed out');
    expect(stopStateOf(1)).toEqual({ phase: 'failed', reason: 'claude stop timed out' });
    vi.advanceTimersByTime(STOP_SESSION_FAILED_SHOW_MS + 1);
    expect(stopStateOf(1)).toBeUndefined();
  });
});
