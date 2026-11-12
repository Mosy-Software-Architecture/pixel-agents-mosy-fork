import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_ACK_GRACE_MS, autoAckTarget, createAutoAckTimer } from '../src/office/autoAck.js';

describe('autoAckTarget', () => {
  const pending = (id: number) => id === 7;
  const view = { shownAgentId: 7, visible: true, focused: true };

  it("is the shown terminal's agent while it is pending in a visible, focused window", () => {
    expect(autoAckTarget(view, pending)).toBe(7);
  });

  it('is none when the user cannot be looking at it', () => {
    expect(autoAckTarget({ ...view, shownAgentId: null }, pending)).toBeNull();
    expect(autoAckTarget({ ...view, visible: false }, pending)).toBeNull();
    expect(autoAckTarget({ ...view, focused: false }, pending)).toBeNull();
  });

  it('is none for an agent that is not pending, or not the shown one', () => {
    expect(autoAckTarget({ ...view, shownAgentId: 3 }, pending)).toBeNull();
    expect(autoAckTarget(view, () => false)).toBeNull();
  });
});

describe('createAutoAckTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acknowledges the target after the grace, not before', () => {
    const ack = vi.fn();
    const timer = createAutoAckTimer(ack);
    timer.sync(7);
    vi.advanceTimersByTime(AUTO_ACK_GRACE_MS - 1);
    expect(ack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ack).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('keeps one running timer for the same target', () => {
    const ack = vi.fn();
    const timer = createAutoAckTimer(ack);
    timer.sync(7);
    vi.advanceTimersByTime(1000);
    timer.sync(7); // e.g. the window took focus again meanwhile
    vi.advanceTimersByTime(AUTO_ACK_GRACE_MS - 1000);
    expect(ack).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('cancels when the target goes (window blurred, terminal switched, acked by hand)', () => {
    const ack = vi.fn();
    const timer = createAutoAckTimer(ack);
    timer.sync(7);
    vi.advanceTimersByTime(1000);
    timer.sync(null);
    vi.advanceTimersByTime(AUTO_ACK_GRACE_MS);
    expect(ack).not.toHaveBeenCalled();
  });

  it('restarts the grace for a new target', () => {
    const ack = vi.fn();
    const timer = createAutoAckTimer(ack);
    timer.sync(7);
    vi.advanceTimersByTime(1000);
    timer.sync(8);
    vi.advanceTimersByTime(AUTO_ACK_GRACE_MS - 1);
    expect(ack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ack).toHaveBeenCalledExactlyOnceWith(8);
  });

  it('fires nothing after dispose', () => {
    const ack = vi.fn();
    const timer = createAutoAckTimer(ack);
    timer.sync(7);
    timer.dispose();
    vi.advanceTimersByTime(AUTO_ACK_GRACE_MS);
    expect(ack).not.toHaveBeenCalled();
  });
});
