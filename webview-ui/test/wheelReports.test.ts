/**
 * The wheel as SGR mouse wheel reports, on a terminal whose program scrolls
 * by them without turning mouse tracking on (Claude Code with
 * CLAUDE_CODE_DISABLE_MOUSE=1, terminal/wheelReports.ts).
 *
 * WHY THIS IS A UNIT TEST, given "E2E over webview unit tests" (CLAUDE.md):
 * the e2e (standalone/background.spec.ts) proves one report reaches the
 * program; the gate's other branches (normal screen, tracking on, a terminal
 * the server did not flag) and the trackpad scaling are a table of cases a
 * browser run would only make slower and vaguer.
 */

import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TERMINAL_WHEEL_FLUSH_MS,
  TERMINAL_WHEEL_MAX_PENDING_REPORTS,
  TERMINAL_WHEEL_REPORTS_PER_FLUSH,
  TERMINAL_WHEEL_ROWS_PER_REPORT,
} from '../src/constants.js';
import type { WheelReportGate } from '../src/terminal/wheelReports.js';
import {
  attachWheelReports,
  flushReports,
  queueReports,
  sgrWheelReport,
  wheelBecomesReports,
  wheelReportSequence,
  wheelStep,
} from '../src/terminal/wheelReports.js';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;
const ROW_H = 20;
const PER_REPORT = ROW_H * TERMINAL_WHEEL_ROWS_PER_REPORT;

const UP = '\x1b[<64;';
const DOWN = '\x1b[<65;';

describe('wheelBecomesReports', () => {
  const flagged: WheelReportGate = {
    wheelReports: true,
    bufferType: 'alternate',
    mouseTrackingMode: 'none',
  };

  it('turns the wheel into reports on the alternate screen of a flagged terminal with tracking off', () => {
    expect(wheelBecomesReports(flagged)).toBe(true);
  });

  it('leaves the normal screen to xterm (its scrollback)', () => {
    expect(wheelBecomesReports({ ...flagged, bufferType: 'normal' })).toBe(false);
  });

  it('leaves it to xterm when the program turned tracking on (xterm reports as asked)', () => {
    for (const mode of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect(wheelBecomesReports({ ...flagged, mouseTrackingMode: mode })).toBe(false);
    }
  });

  it('never sends reports to a terminal the server did not flag (vim, tmux over ssh)', () => {
    expect(wheelBecomesReports({ ...flagged, wheelReports: false })).toBe(false);
  });
});

describe('sgrWheelReport', () => {
  it('is button 64 up and 65 down, at the 1-based cell', () => {
    expect(sgrWheelReport(true, 80, 20)).toBe('\x1b[<64;80;20M');
    expect(sgrWheelReport(false, 1, 1)).toBe('\x1b[<65;1;1M');
  });

  it('repeats one report per notch, negative notches scrolling up', () => {
    expect(wheelReportSequence(-3, 5, 7)).toBe('\x1b[<64;5;7M'.repeat(3));
    expect(wheelReportSequence(2, 5, 7)).toBe('\x1b[<65;5;7M'.repeat(2));
    expect(wheelReportSequence(0, 5, 7)).toBe('');
  });
});

describe('wheelStep', () => {
  it('sends one report per line- or page-mode event, whatever its size (a notch, a touch row)', () => {
    expect(wheelStep(0, { deltaY: -3, deltaMode: LINE }, ROW_H)).toEqual({
      notches: -1,
      remainder: 0,
    });
    expect(wheelStep(0, { deltaY: 1, deltaMode: LINE }, ROW_H)).toEqual({
      notches: 1,
      remainder: 0,
    });
    expect(wheelStep(0, { deltaY: 1, deltaMode: PAGE }, ROW_H).notches).toBe(1);
  });

  it('sends nothing for a horizontal-only event', () => {
    expect(wheelStep(7, { deltaY: 0, deltaMode: PIXEL }, ROW_H)).toEqual({
      notches: 0,
      remainder: 7,
    });
  });

  it('carries trackpad pixels until they make a report', () => {
    let remainder = 0;
    let notches = 0;
    // Small deltas, as a trackpad sends them: one report per PER_REPORT px.
    for (let i = 0; i < 12; i++) {
      const step = wheelStep(remainder, { deltaY: -PER_REPORT / 4, deltaMode: PIXEL }, ROW_H);
      remainder = step.remainder;
      notches += step.notches;
    }
    expect(notches).toBe(-3);
    expect(remainder).toBeCloseTo(0);
  });

  it('makes a Chrome mouse notch (100 px) a few reports, at most one per row', () => {
    const { notches } = wheelStep(0, { deltaY: 100, deltaMode: PIXEL }, ROW_H);
    expect(notches).toBe(Math.trunc(100 / PER_REPORT));
    expect(notches).toBeGreaterThan(0);
    expect(notches).toBeLessThan(100 / ROW_H);
  });

  it('drops the remainder when the direction changes', () => {
    const step = wheelStep(PER_REPORT - 1, { deltaY: -5, deltaMode: PIXEL }, ROW_H);
    expect(step).toEqual({ notches: 0, remainder: -5 });
  });
});

describe('queueReports / flushReports (the pacing)', () => {
  it('flushes bursts of TERMINAL_WHEEL_REPORTS_PER_FLUSH, keeping the sign', () => {
    expect(flushReports(-5)).toEqual({
      send: -TERMINAL_WHEEL_REPORTS_PER_FLUSH,
      left: -5 + TERMINAL_WHEEL_REPORTS_PER_FLUSH,
    });
    expect(flushReports(1)).toEqual({ send: 1, left: 0 });
    expect(flushReports(0)).toEqual({ send: 0, left: 0 });
  });

  it('holds at most TERMINAL_WHEEL_MAX_PENDING_REPORTS, so a flick stops soon after the hand', () => {
    expect(queueReports(0, -100)).toBe(-TERMINAL_WHEEL_MAX_PENDING_REPORTS);
    expect(queueReports(TERMINAL_WHEEL_MAX_PENDING_REPORTS, 3)).toBe(
      TERMINAL_WHEEL_MAX_PENDING_REPORTS,
    );
  });

  it('drops what waits when the direction changes', () => {
    expect(queueReports(4, -1)).toBe(-1);
    expect(queueReports(-2, -1)).toBe(-3);
  });
});

/** Just enough of an xterm Terminal for the handler: its wheel hook, the
 *  active buffer, the tracking mode and the grid (no element: the host's
 *  rect stands in for the cell grid, as before open()). */
function fakeTerminal(state: { bufferType: 'normal' | 'alternate'; tracking: string }) {
  let handler: ((ev: WheelEvent) => boolean) | null = null;
  const term = {
    cols: 100,
    rows: 30,
    element: undefined,
    buffer: {
      get active() {
        return { type: state.bufferType, viewportY: 0 };
      },
    },
    modes: {
      get mouseTrackingMode() {
        return state.tracking;
      },
    },
    attachCustomWheelEventHandler: (h: (ev: WheelEvent) => boolean) => {
      handler = h;
    },
  };
  const host = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 30 * ROW_H }),
  };
  const wheel = (init: { deltaY: number; deltaMode: number; x: number; y: number }) => {
    let prevented = false;
    const ev = {
      deltaY: init.deltaY,
      deltaMode: init.deltaMode,
      shiftKey: false,
      clientX: init.x,
      clientY: init.y,
      cancelable: true,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as WheelEvent;
    const passedOn = handler!(ev);
    return { passedOn, prevented };
  };
  return { term: term as unknown as Terminal, host: host as unknown as HTMLElement, wheel };
}

describe('attachWheelReports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (flag: boolean, bufferType: 'normal' | 'alternate', tracking = 'none') => {
    const state = { bufferType, tracking };
    const { term, host, wheel } = fakeTerminal(state);
    const sent: string[] = [];
    attachWheelReports(term, host, {
      wheelReports: () => flag,
      send: (data) => sent.push(data),
      fallbackRowHeightPx: ROW_H,
    });
    return { sent, wheel, state };
  };

  it('sends a wheel-up report at the cell under the pointer and keeps the event from xterm and the page', () => {
    const { sent, wheel } = setup(true, 'alternate');
    // Column 80 (x 795 in a 10 px grid), row 20 (y 390 in 20 px rows).
    const { passedOn, prevented } = wheel({ deltaY: -1, deltaMode: LINE, x: 795, y: 390 });
    expect(sent).toEqual(['\x1b[<64;80;20M']);
    expect(passedOn).toBe(false);
    expect(prevented).toBe(true);
  });

  it('sends wheel-down reports scaled from pixels', () => {
    const { sent, wheel } = setup(true, 'alternate');
    wheel({ deltaY: PER_REPORT * 2, deltaMode: PIXEL, x: 5, y: 5 });
    expect(sent).toEqual(['\x1b[<65;1;1M'.repeat(2)]);
  });

  it('paces a fast stream into bursts TERMINAL_WHEEL_FLUSH_MS apart and drops the excess', () => {
    const { sent, wheel } = setup(true, 'alternate');
    // A flick: 20 notches' worth at once, faster than the bursts go out.
    for (let i = 0; i < 20; i++) wheel({ deltaY: -1, deltaMode: LINE, x: 5, y: 5 });
    expect(sent).toEqual([UP + '1;1M']);
    vi.advanceTimersByTime(TERMINAL_WHEEL_FLUSH_MS - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(TERMINAL_WHEEL_FLUSH_MS * 10);
    const bursts = sent.map((s) => s.split('M').length - 1);
    expect(Math.max(...bursts)).toBeLessThanOrEqual(TERMINAL_WHEEL_REPORTS_PER_FLUSH);
    expect(bursts.reduce((a, b) => a + b, 0)).toBe(1 + TERMINAL_WHEEL_MAX_PENDING_REPORTS);
  });

  it('passes the event on to xterm on the normal screen, with tracking on, or unflagged', () => {
    for (const [flag, buffer, tracking] of [
      [true, 'normal', 'none'],
      [true, 'alternate', 'any'],
      [false, 'alternate', 'none'],
    ] as const) {
      const { sent, wheel } = setup(flag, buffer, tracking);
      const { passedOn, prevented } = wheel({ deltaY: -1, deltaMode: LINE, x: 5, y: 5 });
      expect(passedOn).toBe(true);
      expect(prevented).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it('follows the screen as the program switches it', () => {
    const { sent, wheel, state } = setup(true, 'normal');
    wheel({ deltaY: 1, deltaMode: LINE, x: 5, y: 5 });
    state.bufferType = 'alternate';
    wheel({ deltaY: 1, deltaMode: LINE, x: 5, y: 5 });
    expect(sent.join('')).toContain(DOWN);
    expect(sent.join('')).not.toContain(UP);
    expect(sent).toHaveLength(1);
  });
});
