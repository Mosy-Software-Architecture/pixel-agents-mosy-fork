import type { ReactNode } from 'react';

/**
 * The two lines left of an agent card's mug shot on the desktop column: the
 * session's name in its /color (and where a remote one runs), then what the
 * agent is doing (office/activityText.ts). One line each, cut with an
 * ellipsis; the width is the card row's (AGENT_CARD_LABEL_WIDTH_PX). A
 * session marked done gets a green check before its name (`done`, drawn by
 * the card: this file stays free of the DOM-measuring icon code, for the
 * Node-run tests).
 */
export function AgentCardLabel({
  name,
  color,
  host,
  activity,
  width,
  done,
}: {
  /** The session's name (office/sessionLabel.ts `sessionName`). */
  name: string;
  /** Its /color as a CSS colour, if it has one the office knows. */
  color?: string;
  /** `@host` / `svc @host` for a remote session (`remoteHostLabel`). */
  host?: string;
  activity: string;
  width: number;
  /** The check of a session marked done (office/sessionMarks.ts), if it is. */
  done?: ReactNode;
}) {
  return (
    <span
      className="flex flex-col justify-center gap-4 min-w-0 shrink-0 leading-none whitespace-nowrap"
      style={{ width }}
      data-testid="agent-card-label"
    >
      <span className="flex items-baseline gap-4 min-w-0">
        {done && (
          <span
            className="shrink-0 flex self-center text-status-success"
            data-testid="agent-card-done"
            aria-label="Done"
          >
            {done}
          </span>
        )}
        <span
          className="overflow-hidden text-ellipsis min-w-0 text-xs"
          style={{ color }}
          data-testid="agent-card-name"
        >
          {name}
        </span>
        {host && <span className="shrink-0 text-2xs text-text-muted">{host}</span>}
      </span>
      <span
        className="overflow-hidden text-ellipsis text-2xs text-text-muted"
        data-testid="agent-card-activity"
      >
        {activity}
      </span>
    </span>
  );
}
