import { describe, expect, it } from 'vitest';

import type { ActivityState } from '../src/office/activityText.js';
import {
  activityStateOf,
  activityText,
  IDLE_TEXT,
  NEEDS_APPROVAL_TEXT,
  WAITING_INPUT_TEXT,
  waitingOnSpawnsText,
} from '../src/office/activityText.js';
import type { ToolActivity } from '../src/office/types.js';

const tool = (status: string, extra: Partial<ToolActivity> = {}): ToolActivity => ({
  toolId: status,
  status,
  done: false,
  ...extra,
});

const state = (over: Partial<ActivityState>): ActivityState => ({
  tools: undefined,
  isActive: false,
  bubble: null,
  awaitingInput: false,
  ...over,
});

describe('activityText', () => {
  it('reads a permission first, from the bubble or a waiting tool', () => {
    expect(activityText(state({ bubble: 'permission', tools: [tool('Running: ls')] }))).toBe(
      NEEDS_APPROVAL_TEXT,
    );
    expect(activityText(state({ tools: [tool('Running: ls', { permissionWait: true })] }))).toBe(
      NEEDS_APPROVAL_TEXT,
    );
  });

  it('says "Waiting for input" only for a turn that asked the user something', () => {
    expect(activityText(state({ bubble: 'waiting', awaitingInput: true }))).toBe(
      WAITING_INPUT_TEXT,
    );
    // A plain finished turn has no words of its own: the checkmark says it.
    expect(activityText(state({ bubble: 'waiting', awaitingInput: false }))).toBe(IDLE_TEXT);
  });

  it('shows the newest running tool', () => {
    const tools = [
      tool('Reading a.ts'),
      tool('Running: npm test'),
      tool('Editing b.ts', { done: true }),
    ];
    expect(activityText(state({ isActive: true, tools }))).toBe('Running: npm test');
  });

  it('keeps the last tool while the turn goes on, and reads Idle once it ends', () => {
    const tools = [tool('Reading a.ts', { done: true }), tool('Editing b.ts', { done: true })];
    expect(activityText(state({ isActive: true, tools }))).toBe('Editing b.ts');
    expect(activityText(state({ isActive: false, tools }))).toBe(IDLE_TEXT);
    expect(activityText(state({}))).toBe(IDLE_TEXT);
  });
});

describe('a lead paused on its background agents', () => {
  it('reads "Waiting on N background agents" over its spawns\' running rows', () => {
    const spawns = [tool('Subtask: Research a'), tool('Subtask: Research b')];
    expect(activityText(state({ pausedForSpawns: 2, tools: spawns }))).toBe(
      'Waiting on 2 background agents',
    );
    expect(waitingOnSpawnsText(1)).toBe('Waiting on 1 background agent');
  });

  it('a permission still comes first', () => {
    expect(activityText(state({ pausedForSpawns: 1, bubble: 'permission' }))).toBe(
      NEEDS_APPROVAL_TEXT,
    );
  });
});

describe('activityStateOf', () => {
  it("lets a pending bubble outlast the character's own", () => {
    const ch = { isActive: false, bubbleType: null, waitingAwaitingInput: true };
    expect(activityStateOf(ch, undefined, 'waiting')).toEqual({
      tools: undefined,
      isActive: false,
      bubble: 'waiting',
      awaitingInput: true,
    });
    expect(activityStateOf(ch, undefined, undefined).bubble).toBeNull();
  });

  it('reads a character not in the office yet as idle', () => {
    expect(activityText(activityStateOf(undefined, undefined, undefined))).toBe(IDLE_TEXT);
  });
});
