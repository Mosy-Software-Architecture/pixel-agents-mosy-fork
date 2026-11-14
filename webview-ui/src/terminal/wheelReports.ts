/**
 * The wheel on a terminal whose program scrolls by mouse wheel reports it
 * never asks for.
 *
 * Claude Code's fullscreen renderer (the alternate screen) scrolls its
 * transcript by SGR wheel reports (`ESC [ < 64 ; col ; row M` up, 65 down).
 * With CLAUDE_CODE_DISABLE_MOUSE=1, which keeps the terminal's own text
 * selection, it never turns mouse tracking on, so xterm.js does not report
 * the wheel: on the alternate screen it sends arrow keys instead (prompt
 * history in Claude Code) and the transcript cannot be scrolled. For a
 * terminal the server says runs such a program
 * (`terminalSessionOpened.wheelReports`), the wheel becomes those reports
 * while the alternate screen is up and tracking is off. Everywhere else xterm
 * keeps the wheel: its own reports when the program turned tracking on,
 * scrollback on the normal screen. Clicks and text selection are never
 * touched.
 *
 * Pacing. Measured on Claude Code 2.1.325: a report scrolls one line, but a
 * stream of reports less than ~35 ms apart accelerates, and fast: 20 in a row
 * scroll 60 lines, 40 scroll 181. Bursts of up to 3 reports at least 50 ms
 * apart stay at one line each. So reports are queued and sent at most
 * TERMINAL_WHEEL_REPORTS_PER_FLUSH every TERMINAL_WHEEL_FLUSH_MS (60 lines a
 * second at most, always one line per report), and the queue is short
 * (TERMINAL_WHEEL_MAX_PENDING_REPORTS): what a trackpad flick sends past it is
 * dropped, so scrolling stops soon after the hand does.
 *
 * Touch scrolling needs nothing of its own: touchInput.ts turns a drag into
 * DOM_DELTA_LINE wheel events dispatched into xterm, which reach this handler
 * like the mouse's (one report per row of drag).
 */

import type { Terminal } from '@xterm/xterm';

import {
  TERMINAL_WHEEL_FLUSH_MS,
  TERMINAL_WHEEL_MAX_PENDING_REPORTS,
  TERMINAL_WHEEL_REPORTS_PER_FLUSH,
  TERMINAL_WHEEL_ROWS_PER_REPORT,
} from '../constants.js';
import { cellFromPoint } from './selectionMath.js';
import { terminalScreenRect } from './terminalDom.js';

/** SGR button codes of the wheel (xterm's 64 + 0 up, 64 + 1 down). */
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

/** What decides whether the wheel becomes reports. */
export interface WheelReportGate {
  /** The server says the terminal's program scrolls by unrequested reports. */
  wheelReports: boolean;
  /** xterm's active buffer. */
  bufferType: 'normal' | 'alternate';
  /** xterm's mouse tracking mode, as the program set it. */
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
}

/** Only on the alternate screen of such a program, and only while it has not
 *  turned tracking on itself (then xterm reports, exactly as it asked). */
export function wheelBecomesReports(gate: WheelReportGate): boolean {
  return gate.wheelReports && gate.bufferType === 'alternate' && gate.mouseTrackingMode === 'none';
}

/** The SGR wheel report for one notch at a 1-based cell. */
export function sgrWheelReport(up: boolean, col: number, row: number): string {
  return `\x1b[<${String(up ? SGR_WHEEL_UP : SGR_WHEEL_DOWN)};${String(col)};${String(row)}M`;
}

/** |notches| reports of sign(notches) at a 1-based cell (negative = up). */
export function wheelReportSequence(notches: number, col: number, row: number): string {
  return sgrWheelReport(notches < 0, col, row).repeat(Math.abs(notches));
}

/** The slice of a WheelEvent the scaling reads. */
export interface WheelDelta {
  deltaY: number;
  deltaMode: number;
}

/** Notches for one wheel event, and the pixel remainder carried. */
export interface WheelStep {
  /** Signed: negative scrolls up (toward older lines). */
  notches: number;
  /** Signed pixels not yet worth a notch. */
  remainder: number;
}

const DOM_DELTA_PIXEL = 0;

/**
 * The scaling. A line- or page-mode event is a notch of a wheel with notches
 * (or one row of a touch drag, touchInput.ts): one report. A pixel-mode event
 * (a trackpad, or a mouse in a browser that reports pixels: Chrome's notch is
 * about 100 px) adds its pixels to the remainder, one report per
 * TERMINAL_WHEEL_ROWS_PER_REPORT rows of them. A change of direction drops the
 * remainder.
 */
export function wheelStep(remainder: number, delta: WheelDelta, rowHeightPx: number): WheelStep {
  if (delta.deltaY === 0) return { notches: 0, remainder };
  const sign = Math.sign(delta.deltaY);
  if (delta.deltaMode !== DOM_DELTA_PIXEL) return { notches: sign, remainder: 0 };
  const carried = Math.sign(remainder) === -sign ? 0 : remainder;
  const total = carried + delta.deltaY;
  const perReport = Math.max(1, rowHeightPx * TERMINAL_WHEEL_ROWS_PER_REPORT);
  // `|| 0`: no -0 for "no report up".
  const notches = Math.trunc(total / perReport) || 0;
  return { notches, remainder: total - notches * perReport };
}

/** The queue after new notches: a change of direction replaces what waits,
 *  and it never holds more than TERMINAL_WHEEL_MAX_PENDING_REPORTS. */
export function queueReports(pending: number, notches: number): number {
  const base = Math.sign(pending) === -Math.sign(notches) ? 0 : pending;
  const total = base + notches;
  return Math.sign(total) * Math.min(Math.abs(total), TERMINAL_WHEEL_MAX_PENDING_REPORTS) || 0;
}

/** What one flush sends (signed) and what stays queued. */
export function flushReports(pending: number): { send: number; left: number } {
  const send = Math.sign(pending) * Math.min(Math.abs(pending), TERMINAL_WHEEL_REPORTS_PER_FLUSH);
  return { send: send || 0, left: pending - send || 0 };
}

export interface WheelReportOptions {
  /** Read on every event: the server may say so after the pane opened. */
  wheelReports: () => boolean;
  /** Write to the PTY (the path keystrokes take). */
  send: (data: string) => void;
  /** Row height before the grid is measured. */
  fallbackRowHeightPx: number;
}

/**
 * Hook the translation into xterm's wheel handling. xterm asks its custom
 * wheel handler before anything else; returning false skips its own handling
 * (the arrow keys on the alternate screen), returning true leaves the event to
 * it. One handler per terminal: xterm keeps only the last one attached.
 * Returns the cleanup of the pacing timer (the handler goes with the terminal).
 */
export function attachWheelReports(
  term: Terminal,
  host: HTMLElement,
  options: WheelReportOptions,
): () => void {
  let remainder = 0;
  let pending = 0;
  let cell = { col: 1, row: 1 };
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Send a burst now, then hold the next one TERMINAL_WHEEL_FLUSH_MS: the gap
  // Claude Code needs to keep a line per report.
  const flush = () => {
    const { send, left } = flushReports(pending);
    pending = left;
    if (send === 0) {
      timer = null;
      return;
    }
    options.send(wheelReportSequence(send, cell.col, cell.row));
    timer = setTimeout(flush, TERMINAL_WHEEL_FLUSH_MS);
  };

  term.attachCustomWheelEventHandler((ev) => {
    const gate: WheelReportGate = {
      wheelReports: options.wheelReports(),
      bufferType: term.buffer.active.type,
      mouseTrackingMode: term.modes.mouseTrackingMode,
    };
    if (!wheelBecomesReports(gate) || ev.deltaY === 0 || ev.shiftKey) {
      remainder = 0;
      pending = 0;
      return true;
    }
    // The page under the pane must not scroll, nor xterm's listener after us.
    if (ev.cancelable) ev.preventDefault();
    ev.stopPropagation();
    const rect = terminalScreenRect(term, host);
    const rowHeight = rect.height > 0 && term.rows > 0 ? rect.height / term.rows : 0;
    const step = wheelStep(remainder, ev, rowHeight || options.fallbackRowHeightPx);
    remainder = step.remainder;
    if (step.notches !== 0) {
      const at = cellFromPoint(rect, term.cols, term.rows, 0, ev.clientX, ev.clientY);
      cell = { col: at.col + 1, row: at.row + 1 };
      pending = queueReports(pending, step.notches);
      if (timer === null) flush();
    }
    return false;
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
