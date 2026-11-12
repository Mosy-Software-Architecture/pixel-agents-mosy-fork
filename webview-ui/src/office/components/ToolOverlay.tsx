import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { PixelIcon } from '../../components/ui/PixelIcon.js';
import type { PixelIconName } from '../../components/ui/pixelIcons.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  CHARACTER_SITTING_OFFSET_PX,
  CONTEXT_GAUGE_GAP_PX,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  OVERLAY_LABEL_HOVERED_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { useShowDirectoryNames } from '../../hooks/useShowDirectoryNames.js';
import { activityIcon, IDLE_ICON, STICKY_ACTIVITY_ICONS } from '../activityIcon.js';
import {
  activityStateOf,
  activityText,
  NEEDS_APPROVAL_TEXT,
  runningTool,
  WAITING_INPUT_TEXT,
} from '../activityText.js';
import { ContextBar } from '../ContextBar.js';
import { contextLeft } from '../contextGauge.js';
import { shownDirectoryName } from '../directoryNames.js';
import type { OfficeState } from '../engine/officeState.js';
import { pendingAckOf } from '../pendingAck.js';
import { overlayProjection } from '../projection.js';
import { agentSessionInfo, remoteHostLabel, sessionColor, sessionName } from '../sessionLabel.js';
import { characterZoom } from '../subagentScale.js';
import type { ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  /** Settings → Always Show Activity Icons: every character's icon, not only
   *  the hovered or selected one's (the waiting ones always show). */
  alwaysShowOverlay: boolean;
}

/** The icons that speak for an agent waiting on the user, in its status colour. */
const ICON_COLOR: Partial<Record<PixelIconName, string>> = {
  check: 'text-status-success',
  hand: 'text-status-permission',
  question: 'text-status-permission',
};

/** One activity icon in a small pixel panel: `unit` CSS px per icon pixel
 *  (the character's zoom, so it is drawn as crisply as the sprite under it). */
function ActivityBadge({
  name,
  unit,
  opacity,
}: {
  name: PixelIconName;
  unit: number;
  opacity: number;
}) {
  return (
    <span
      className={`flex bg-bg border-border ${ICON_COLOR[name] ?? 'text-text'}`}
      style={{ borderWidth: unit, borderStyle: 'solid', padding: unit, opacity }}
      data-testid="activity-icon"
      data-icon={name}
    >
      <PixelIcon name={name} scale={unit} />
    </span>
  );
}

/**
 * Over each character: an 8×8 icon saying what its agent is doing
 * (office/activityIcon.ts), and, while it is hovered or selected, a small
 * panel with its session's name. The activity's words live on the agent's
 * card (AgentCard); here they are screen-reader text only.
 */
export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  // Settings → Show Directory Names: a line of the name panel.
  const showDirectory = useShowDirectoryNames();
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr turns device pixels (zoom) into the CSS px the DOM is laid out in.
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;
  // Hovering a sub-agent hides its lead's name panel (they'd overlap).
  const hoveredSubParentId =
    hoveredId !== null
      ? subagentCharacters.find((s) => s.id === hoveredId)?.parentAgentId
      : undefined;

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)];

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;
        const sub = isSub ? subagentCharacters.find((s) => s.id === id) : undefined;
        // An agent that rang and hasn't been acknowledged keeps its icon
        // (office/pendingAck.ts): the hand, or the checkmark of its finished
        // turn, at full strength until the user looks.
        const pending = pendingAckOf(id);
        const tools = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : agentTools[id];
        const ownState = activityStateOf(ch, tools, pending);
        // A sub-agent stands idle in the gaps between its tools (every row
        // done, useExtensionMessages): while it has any it is at work, and
        // keeps its last tool's icon like its lead does.
        const state = isSub && tools?.length ? { ...ownState, isActive: true } : ownState;
        const icon = activityIcon(state);
        // The icon shows for the hovered or selected character, for every one
        // with Always Show on, and always while it waits on the user. The
        // idle cup only with Always Show on.
        const showIcon =
          icon === IDLE_ICON
            ? alwaysShowOverlay
            : alwaysShowOverlay || isSelected || isHovered || STICKY_ACTIVITY_ICONS.has(icon);
        // The label element e2e reads: where the old text label used to be
        // (Always Show on, or hovered/selected).
        const labelShown = alwaysShowOverlay || isSelected || isHovered;
        if (!labelShown && !showIcon) return null;

        // A finished turn's check (and the question) fades with the bubble
        // it stands for, unless the agent is still pending.
        const iconOpacity =
          state.bubble === 'waiting' && !pending && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
            ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
            : 1;

        // What the old text label over the character said, now for screen
        // readers (and the e2e specs) only: who it is (unless the name panel
        // shows it), what it is doing, where. Same rules: a Done agent says
        // nothing (its checkmark does), a sub-agent only while hovered or
        // selected, and a hovered sub-agent's lead gives way to it.
        const isDone = !pending && state.bubble === 'waiting' && !state.awaitingInput;
        const givesWay = (isSub && !isSelected && !isHovered) || id === hoveredSubParentId;
        const quiet = (isDone && !isSelected && !isHovered) || givesWay;
        const showName = (isSelected || isHovered) && id !== hoveredSubParentId;
        const subLabel = sub?.label || 'Subtask';
        const directoryName = shownDirectoryName(ch.directoryName, showDirectory);
        let spokenText: string | null = null;
        if (quiet) {
          // Nothing to say.
        } else if (isSub) {
          if (state.bubble === 'waiting' && state.awaitingInput) spokenText = WAITING_INPUT_TEXT;
          else if (state.bubble === 'permission') spokenText = NEEDS_APPROVAL_TEXT;
          // Selecting a sub-agent reveals its live tool; hovering, its task.
          else spokenText = (isSelected ? runningTool(state.tools)?.status : undefined) ?? subLabel;
        } else {
          const session = agentSessionInfo(id);
          const who = showName ? [] : [session?.title, teamRoleOf(ch)];
          const where = showName ? [] : [directoryName, remoteHostLabel(session)];
          spokenText = [...who, activityText(state), ...where].filter(Boolean).join(', ');
        }

        // Stacked upward from the head: a sub-agent's is lower (drawn one
        // zoom step smaller, office/subagentScale.ts), and so is its icon.
        const chZoom = characterZoom(isSub, zoom);
        const unit = chZoom / dpr;
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const headTop =
          project.toScreenY(ch.y) + ((sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * chZoom) / dpr;

        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        // Its icon slot keeps its size when empty, so the name sits still.
        const badgeSide = 12 * unit;

        return (
          <div
            key={id}
            // The stack grows upward from the head, so the name and the
            // context gauge never reach down over it.
            className="absolute flex flex-col items-center -translate-x-1/2 -translate-y-full"
            style={{
              left: screenX,
              top: headTop - unit,
              pointerEvents: showName && isSelected ? 'auto' : 'none',
              zIndex: !showName
                ? OVERLAY_LABEL_Z_INDEX
                : isSelected
                  ? OVERLAY_LABEL_SELECTED_Z_INDEX
                  : OVERLAY_LABEL_HOVERED_Z_INDEX,
            }}
            data-testid={labelShown ? 'agent-overlay' : undefined}
            data-agent-id={labelShown ? id : undefined}
          >
            {showName &&
              (isSub ? (
                <NamePanel>
                  <span className="block leading-none italic" style={{ fontSize: '20px' }}>
                    {subLabel}
                  </span>
                </NamePanel>
              ) : (
                <AgentNamePanel
                  id={id}
                  teamRole={teamRoleOf(ch)}
                  isTeamLead={ch.isTeamLead}
                  directoryName={directoryName}
                  onClose={isSelected ? () => onCloseAgent(id) : undefined}
                />
              ))}
            {/* Every agent's context gauge, under its name (sub-agents have
                no session of their own, so never one). Health-bar style:
                full when the context is empty, draining as it fills. */}
            {showName && !isSub && ch.contextReported === true && (
              <ContextBar
                used={contextRatio}
                width={CONTEXT_GAUGE_WIDTH_PX}
                height={CONTEXT_GAUGE_HEIGHT_PX}
                style={{ marginTop: CONTEXT_GAUGE_GAP_PX }}
                title={`${Math.round(contextLeft(contextRatio) * 100)}% context left (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens used)`}
                testId="context-gauge"
                pct={Math.round(contextRatio * 100)}
              />
            )}
            <div
              className="flex items-end justify-center"
              style={{ width: badgeSide, height: badgeSide, marginTop: showName ? unit : 0 }}
            >
              {showIcon && <ActivityBadge name={icon} unit={unit} opacity={iconOpacity} />}
            </div>
            {spokenText && <span className="sr-only">{spokenText}</span>}
          </div>
        );
      })}
    </>
  );
}

/** A team member's role: LEAD, or a teammate's name. */
function teamRoleOf(ch: { isTeamLead?: boolean; agentName?: string }): string | undefined {
  return ch.isTeamLead ? 'LEAD' : ch.agentName || undefined;
}

/** The small panel over a hovered or selected character: its lines, then
 *  anything trailing them (the selected agent's ×). */
function NamePanel({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
      <div className="flex flex-col gap-0 overflow-hidden">{children}</div>
      {trailing}
    </div>
  );
}

/** A hovered or selected agent's name panel: its session's name in its
 *  /color, its team role, Directory and remote host; × when selected. */
function AgentNamePanel({
  id,
  teamRole,
  isTeamLead,
  directoryName,
  onClose,
}: {
  id: number;
  teamRole: string | undefined;
  isTeamLead?: boolean;
  directoryName: string | undefined;
  onClose?: () => void;
}) {
  const session = agentSessionInfo(id);
  return (
    <NamePanel
      trailing={
        onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close agent"
            className="ml-2 shrink-0"
          >
            {/* The panel's padding favours the text (pb > pt) and the × fills
                rows 1–5 of its grid: 3px lower centres it on the label line. */}
            <PixelIcon name="close" className="translate-y-3" />
          </Button>
        )
      }
    >
      <span
        className="overflow-hidden text-ellipsis block leading-none"
        style={{ fontSize: '20px', color: sessionColor(session?.color) }}
        data-testid="agent-session-title"
        data-session-color={session?.color}
      >
        {sessionName(id, session?.title)}
      </span>
      {teamRole && (
        <span
          className="overflow-hidden text-ellipsis block leading-none"
          style={{
            fontSize: '18px',
            color: isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR,
            fontWeight: isTeamLead ? 'bold' : undefined,
          }}
        >
          {teamRole}
        </span>
      )}
      {directoryName && (
        <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
          {directoryName}
        </span>
      )}
      {/* A remote host's session: where it runs, whether or not Directory
          names show. */}
      {session?.host && (
        <span
          className="text-2xs leading-none overflow-hidden text-ellipsis block text-text-muted"
          data-testid="agent-remote-host"
        >
          {remoteHostLabel(session)}
        </span>
      )}
    </NamePanel>
  );
}
