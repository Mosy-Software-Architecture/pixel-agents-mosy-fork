/**
 * The 8×8 icon over a character (ToolOverlay): what its agent is doing, read
 * from the same state as its activity label (activityText.ts). Pure, so it
 * runs on the Node test runner.
 */

import type { PixelIconName } from '../components/ui/pixelIcons.js';
import type { ActivityState } from './activityText.js';
import { runningTool } from './activityText.js';
import { extractToolName } from './toolUtils.js';

/** The icon a tool shows while it runs, by tool name. */
const TOOL_ICONS: Record<string, PixelIconName> = {
  Bash: 'terminal',
  Read: 'book',
  Grep: 'book',
  Glob: 'book',
  Edit: 'pencil',
  MultiEdit: 'pencil',
  Write: 'pencil',
  NotebookEdit: 'pencil',
  WebFetch: 'globe',
  WebSearch: 'globe',
  SendMessage: 'envelope',
  ToolSearch: 'search',
  Agent: 'branch',
  Task: 'branch',
  TeamCreate: 'branch',
  AskUserQuestion: 'question',
};

/** The icon for a running tool, from its status line: its own, the gear for
 *  an MCP tool, a magnifier for any other search, else the gear too. */
export function toolIcon(status: string): PixelIconName {
  const name = extractToolName(status) ?? '';
  if (Object.hasOwn(TOOL_ICONS, name)) return TOOL_ICONS[name];
  if (name.startsWith('mcp__')) return 'service';
  if (/search/i.test(name)) return 'search';
  return 'service';
}

/** The icons that show whether or not the character is hovered: the agent
 *  waits on the user (a finished turn, a permission, a question). */
export const STICKY_ACTIVITY_ICONS: ReadonlySet<PixelIconName> = new Set<PixelIconName>([
  'check',
  'hand',
  'question',
]);

/** The icon over a character, or null when it has nothing to say (idle). */
export function activityIcon({
  tools,
  isActive,
  bubble,
  awaitingInput,
}: ActivityState): PixelIconName | null {
  if (bubble === 'permission') return 'hand';
  if (bubble === 'waiting') return awaitingInput ? 'question' : 'check';
  const active = runningTool(tools);
  if (active) return active.permissionWait ? 'hand' : toolIcon(active.status);
  // A turn in progress with no tool running: thinking or writing.
  return isActive ? 'hourglass' : null;
}
