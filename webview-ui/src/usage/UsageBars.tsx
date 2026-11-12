import { type CSSProperties, useEffect, useRef, useState } from 'react';

import type { UsageLimits } from '../../../core/src/messages.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  CONTEXT_GAUGE_COLOR_YELLOW,
  USAGE_BAR_HEIGHT_PX,
  USAGE_BAR_TICK_MS,
  USAGE_BAR_WIDTH_PX,
  USAGE_BARS_LEFT_PX,
  USAGE_BARS_SINGLE_COLUMN_MAX,
} from '../constants.js';
import { PixelHeart } from './PixelHeart.js';
import {
  endpointNote,
  freshnessLabel,
  heartBeatPeriodSec,
  type UsageBarSpec,
  usageBarSpecs,
  type UsageBarView,
} from './usageBarView.js';

type Fill = Record<UsageBarView['level'], string>;

/** Fill colour per level. The two main bars differ all the way down, like a
 *  game's health and stamina: weekly green → yellow → red, 5-hour blue →
 *  purple → red (yellow at half would make them look alike). The extra bars
 *  (a model's share, extra usage) drain like the weekly one. */
const WEEKLY_FILL: Fill = {
  ok: 'var(--color-status-success)',
  warn: CONTEXT_GAUGE_COLOR_YELLOW,
  low: 'var(--color-danger)',
  unknown: 'transparent',
};
const FIVE_HOUR_FILL: Fill = {
  ok: 'var(--color-status-active)',
  warn: 'var(--color-usage-five-hour-warn)',
  low: 'var(--color-danger)',
  unknown: 'transparent',
};

/** One bar as drawn: what it shows, and its colours. */
interface Bar extends UsageBarSpec {
  fill: Fill;
}

interface UsageBarsProps {
  /** The last usageLimits for the provider; undefined until the server sends it. */
  limits: UsageLimits | undefined;
  /** Whose plan it is, for people (usageBridgeStatus.providerName). */
  providerName: string;
  /** Phone: below the safe area, beside the menu button. */
  mobile: boolean;
}

/** The current time, re-read every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** What hovering a bar says: "Weekly · resets in 3d 11h",
 *  "Fable · 22% of the weekly budget used, 50% allowed · resets in 1d 5h". */
function hoverText({ name, view }: Bar): string {
  return [name, view.detail, view.reset].filter(Boolean).join(' · ');
}

function ResetLabel({ bar }: { bar: Bar }) {
  return <PixelText text={hoverText(bar)} shadow className="text-2xs text-text" />;
}

/** One bar with its share left printed inside, and (while the block is
 *  hovered, when there is room) its reset time just right of it. */
function BarRow({ bar, showReset, style }: { bar: Bar; showReset: boolean; style: CSSProperties }) {
  return (
    <div className="flex items-center gap-4" style={style} title={bar.view.detail}>
      <div
        className="relative bg-bg-dark border-2 border-border box-content flex items-center pl-4"
        style={{ width: USAGE_BAR_WIDTH_PX, height: USAGE_BAR_HEIGHT_PX }}
      >
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: `${(bar.view.remaining ?? 0) * 100}%`,
            background: bar.fill[bar.view.level],
          }}
        />
        <PixelText text={bar.view.percent} shadow className="relative text-2xs text-text" />
      </div>
      {showReset && <ResetLabel bar={bar} />}
    </div>
  );
}

/**
 * Top-left of the office: how much of the provider's plan is left
 * (`providerName`, e.g. Claude Code). A heart, then one bar per window the
 * account reports, and only those (usageBarSpecs): the weekly bar (green) over
 * the 5-hour bar (blue; none on a plan without that window), equal in size,
 * each draining through its own colours to red, each with its share left
 * inside. Under them, one bar per extra window the account usage endpoint
 * reported (a model's share of the weekly budget, extra usage), its name left
 * of it, draining like the weekly one; past USAGE_BARS_SINGLE_COLUMN_MAX bars
 * in all, two per row. A window that appears or goes away on a later report
 * adds or drops its bar.
 *
 * Hovering any of it makes the heart beat, at a pace proportional to the
 * weekly plan left, and shows when each bar resets: right of it, or (two per
 * row, or on a phone, where a tap does it and a tap elsewhere undoes it)
 * listed below the bars.
 */
export function UsageBars({ limits, providerName, mobile }: UsageBarsProps) {
  const now = useNow(USAGE_BAR_TICK_MS);
  const [active, setActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Phone: a tap anywhere else closes it again.
  useEffect(() => {
    if (!mobile || !active) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setActive(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [mobile, active]);

  const all: Bar[] = usageBarSpecs(limits, now).map((spec) => ({
    ...spec,
    fill: spec.kind === 'fiveHour' ? FIVE_HOUR_FILL : WEEKLY_FILL,
  }));
  const main = all.filter((bar) => bar.kind !== 'extra');
  const extras = all.filter((bar) => bar.kind === 'extra');
  const weekly = all.find((bar) => bar.kind === 'weekly');
  const perRow = all.length > USAGE_BARS_SINGLE_COLUMN_MAX ? 2 : 1;
  // Reset times right of each bar on a desktop with one column, else below.
  const showResetBeside = active && !mobile && perRow === 1;
  const showResetBelow = active && !showResetBeside;
  const note = endpointNote(limits, providerName);
  const title = freshnessLabel(limits?.updatedAt, now, providerName) + (note ? `. ${note}` : '');

  return (
    <div
      ref={rootRef}
      className={`absolute z-10 cursor-default ${mobile ? 'mobile-safe-top' : 'top-8'}`}
      style={{ left: USAGE_BARS_LEFT_PX }}
      title={title}
      aria-label={`${providerName} usage. ${all
        .map((bar) => `${bar.name}: ${bar.view.percent} left. ${hoverText(bar)}.`)
        .join(' ')}`}
      // A phone's tap also fires the emulated mouseenter, which would cancel
      // the click's toggle, so there only the tap counts.
      onMouseEnter={mobile ? undefined : () => setActive(true)}
      onMouseLeave={mobile ? undefined : () => setActive(false)}
      onClick={mobile ? () => setActive((a) => !a) : undefined}
    >
      <div className="grid items-center gap-x-8 gap-y-2">
        <div
          className="flex justify-end"
          style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(1, main.length)}` }}
        >
          <PixelHeart
            periodSec={active ? heartBeatPeriodSec(weekly?.view.remaining ?? null) : null}
          />
        </div>
        {main.map((bar, i) => (
          <BarRow
            key={bar.key}
            bar={bar}
            showReset={showResetBeside}
            style={{ gridColumn: 2, gridRow: 1 + i }}
          />
        ))}
        {extras.map((bar, i) => {
          const row = Math.max(1, main.length) + 1 + Math.floor(i / perRow);
          const column = 1 + 2 * (i % perRow);
          return [
            <PixelText
              key={`${bar.key}-label`}
              text={bar.name}
              shadow
              className="text-2xs text-text justify-self-end"
              style={{ gridColumn: column, gridRow: row }}
            />,
            <BarRow
              key={bar.key}
              bar={bar}
              showReset={showResetBeside}
              style={{ gridColumn: column + 1, gridRow: row }}
            />,
          ];
        })}
      </div>
      {showResetBelow && (
        <div className="absolute top-full left-0 mt-6 flex flex-col gap-4 pointer-events-none">
          {all.map((bar) => (
            <ResetLabel key={bar.key} bar={bar} />
          ))}
        </div>
      )}
    </div>
  );
}
