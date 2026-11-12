import { describe, expect, it } from 'vitest';

import { ICONS } from '../src/components/ui/pixelIcons.js';
import {
  activityIcon,
  IDLE_ICON,
  STICKY_ACTIVITY_ICONS,
  toolIcon,
} from '../src/office/activityIcon.js';
import type { ActivityState } from '../src/office/activityText.js';
import { extractToolName } from '../src/office/toolUtils.js';
import type { ToolActivity } from '../src/office/types.js';

const tool = (status: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  toolId: status,
  status,
  done: false,
  ...extra,
});

const state = (over: Partial<ActivityState>): ActivityState => ({
  tools: undefined,
  isActive: true,
  bubble: null,
  awaitingInput: false,
  ...over,
});

describe('extractToolName', () => {
  // The statuses are the Claude provider's formatToolStatus lines.
  it.each([
    ['Reading foo.ts', 'Read'],
    ['Searching code', 'Grep'],
    ['Searching files', 'Glob'],
    ['Searching the web', 'WebSearch'],
    ['Fetching web content', 'WebFetch'],
    ['Editing foo.ts', 'Edit'],
    ['Editing notebook', 'NotebookEdit'],
    ['Writing foo.ts', 'Write'],
    ['Running: npm test', 'Bash'],
    ['Running subtask', 'Task'],
    ['Subtask: fix the login', 'Task'],
    ['Sending message', 'SendMessage'],
    ['-> lead', 'SendMessage'],
    ['Waiting for your answer', 'AskUserQuestion'],
    ['Waiting for plan approval', 'ExitPlanMode'],
    ['Using ToolSearch', 'ToolSearch'],
    ['Using mcp__linear__get_issue', 'mcp__linear__get_issue'],
  ])('%s -> %s', (status, name) => {
    expect(extractToolName(status)).toBe(name);
  });
});

describe('toolIcon', () => {
  it.each([
    ['Running: npm test', 'terminal'],
    ['Reading foo.ts', 'book'],
    ['Searching code', 'book'],
    ['Searching files', 'book'],
    ['Editing foo.ts', 'pencil'],
    ['Writing foo.ts', 'pencil'],
    ['Editing notebook', 'pencil'],
    ['Fetching web content', 'globe'],
    ['Searching the web', 'globe'],
    ['-> lead', 'envelope'],
    ['Sending message', 'envelope'],
    ['Using ToolSearch', 'search'],
    ['Using DeepSearch', 'search'],
    ['Subtask: fix the login', 'branch'],
    ['Running subtask', 'branch'],
    ['Using mcp__linear__search_issues', 'service'],
    ['Using TodoWrite', 'service'],
  ])('%s -> %s', (status, icon) => {
    expect(toolIcon(status)).toBe(icon);
  });
});

describe('activityIcon', () => {
  it('asks for the user first: hand, question, check', () => {
    expect(activityIcon(state({ bubble: 'permission' }))).toBe('hand');
    expect(activityIcon(state({ tools: [tool('Running: ls', { permissionWait: true })] }))).toBe(
      'hand',
    );
    expect(activityIcon(state({ bubble: 'waiting', awaitingInput: true }))).toBe('question');
    expect(activityIcon(state({ bubble: 'waiting', isActive: false }))).toBe('check');
  });

  it("shows the running tool's icon", () => {
    expect(
      activityIcon(state({ tools: [tool('Reading a.ts', { done: true }), tool('Running: ls')] })),
    ).toBe('terminal');
  });

  it("keeps the last tool's icon between tools; the hourglass only before the first", () => {
    // Between two tools (the last one done, the next not started yet).
    expect(
      activityIcon(
        state({
          tools: [tool('Running: ls', { done: true }), tool('Reading a.ts', { done: true })],
        }),
      ),
    ).toBe('book');
    // A turn that hasn't run a tool yet: thinking or writing.
    expect(activityIcon(state({}))).toBe('hourglass');
    expect(activityIcon(state({ tools: [] }))).toBe('hourglass');
  });

  it('shows the hourglass once a question is answered (thinking about the answer)', () => {
    expect(
      activityIcon(
        state({
          tools: [
            tool('Running: ls', { done: true }),
            tool('Waiting for your answer', { done: true }),
          ],
        }),
      ),
    ).toBe('hourglass');
  });

  it('reads the cup for an idle agent, its last tool or not', () => {
    expect(IDLE_ICON).toBe('coffee');
    expect(activityIcon(state({ isActive: false }))).toBe('coffee');
    expect(activityIcon(state({ isActive: false, tools: [tool('Edit a', { done: true })] }))).toBe(
      'coffee',
    );
  });

  it('shows the question for a pending AskUserQuestion or ExitPlanMode tool row', () => {
    expect(toolIcon('Waiting for your answer')).toBe('question');
    expect(toolIcon('Waiting for plan approval')).toBe('question');
  });

  it('keeps only the icons that wait on the user sticky', () => {
    expect([...STICKY_ACTIVITY_ICONS].sort()).toEqual(['check', 'hand', 'question']);
  });

  it('draws every icon it names as an 8×8 grid', () => {
    for (const name of [
      'terminal',
      'book',
      'pencil',
      'globe',
      'envelope',
      'search',
      'branch',
      'service',
      'hourglass',
      'coffee',
      'check',
      'hand',
      'question',
    ] as const) {
      const grid = ICONS[name];
      expect(grid).toHaveLength(8);
      for (const row of grid) expect(row).toHaveLength(8);
    }
  });
});
