/**
 * Acknowledging an agent by already looking at it. When an agent rings
 * (office/pendingAck.ts) while its terminal is the one the drawer shows and
 * this window is in front with focus, the user is watching it: after a short
 * grace (the chime plays, the icon flashes once) its pending marker clears by
 * itself, as a click would. It clears the same way when the window comes back
 * to the front on that terminal. Pure, so it runs on the Node test runner.
 */

/** How long a ring the user is watching stays pending. */
export const AUTO_ACK_GRACE_MS = 1500;

/** What the user can see right now. */
export interface AutoAckView {
  /** The agent whose terminal the drawer shows; null with the drawer closed. */
  shownAgentId: number | null;
  /** `document.visibilityState === 'visible'`: the tab is in front. */
  visible: boolean;
  /** `document.hasFocus()`: the window has the keyboard. */
  focused: boolean;
}

/** The agent to acknowledge without a click, if any: the shown terminal's,
 *  while it is pending and the window is visible and focused. */
export function autoAckTarget(
  view: AutoAckView,
  isPending: (agentId: number) => boolean,
): number | null {
  const id = view.shownAgentId;
  return id !== null && view.visible && view.focused && isPending(id) ? id : null;
}

/** The grace timer: `sync(target)` arms it for a new target, leaves it
 *  running for the same one, and cancels it when there is none. */
export interface AutoAckTimer {
  sync(target: number | null): void;
  dispose(): void;
}

export function createAutoAckTimer(
  ack: (agentId: number) => void,
  graceMs = AUTO_ACK_GRACE_MS,
): AutoAckTimer {
  let armed: { id: number; timer: ReturnType<typeof setTimeout> } | null = null;
  const dispose = () => {
    if (armed) clearTimeout(armed.timer);
    armed = null;
  };
  return {
    sync(target) {
      if (armed?.id === target) return;
      dispose();
      if (target === null) return;
      const id = target;
      armed = {
        id,
        timer: setTimeout(() => {
          armed = null;
          ack(id);
        }, graceMs),
      };
    },
    dispose,
  };
}
