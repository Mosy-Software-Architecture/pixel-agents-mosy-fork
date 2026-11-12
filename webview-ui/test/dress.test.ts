import { describe, expect, it } from 'vitest';

import { dressLabel, dressTargetOf } from '../src/characters/dress.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function office(): OfficeState {
  const cols = 4;
  const rows = 4;
  const layout: OfficeLayout = {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
  return new OfficeState(layout);
}

describe('dressTargetOf (the roster Wear button)', () => {
  it('dresses the selected agent, named after its session', () => {
    expect(dressTargetOf({ id: 3, palette: 2, isSubagent: false }, 'fix the build')).toEqual({
      agentId: 3,
      agentLabel: 'fix the build',
      wornPalette: 2,
    });
  });

  it('falls back to "Agent N" for a session with no name yet', () => {
    expect(dressTargetOf({ id: 3, palette: 2, isSubagent: false }, undefined)?.agentLabel).toBe(
      'Agent 3',
    );
  });

  it("leaves the roster alone with nothing selected, or a character that wears its Lead's look", () => {
    expect(dressTargetOf(undefined, undefined)).toBeNull();
    expect(dressTargetOf({ id: -1, palette: 2, isSubagent: true }, undefined)).toBeNull();
    expect(
      dressTargetOf({ id: 5, palette: 2, isSubagent: false, leadAgentId: 3 }, 'helper'),
    ).toBeNull();
  });

  it('names what the button does', () => {
    const target = dressTargetOf({ id: 3, palette: 2, isSubagent: false }, 'fix the build')!;
    expect(dressLabel(target, 'Aura')).toBe('Dress fix the build as Aura');
  });
});

describe('OfficeState looks', () => {
  it('a new look reaches the agent and its sub-agents, and tells its subscribers', () => {
    const os = office();
    os.addAgent(1, 0, 0, undefined, true);
    const sub = os.addSubagent(1, 'tool-1');
    let calls = 0;
    const unsubscribe = os.subscribeLooks(() => calls++);
    const before = os.looksVersion;

    os.setAgentLook(1, 4, 1);

    expect(os.characters.get(1)).toMatchObject({ palette: 4, repeat: 1 });
    expect(os.characters.get(sub)).toMatchObject({ palette: 4, repeat: 1 });
    expect(calls).toBe(1);
    expect(os.looksVersion).toBe(before + 1);
    unsubscribe();
    os.setAgentLook(1, 5, 0);
    expect(calls).toBe(1);
  });

  it("a reconnect's snapshot tells subscribers only when the look changed", () => {
    const os = office();
    os.addAgent(1, 2, 0, undefined, true);
    let calls = 0;
    os.subscribeLooks(() => calls++);

    os.syncAgent(1, 2, 0);
    expect(calls).toBe(0);
    os.syncAgent(1, 3, 0);
    expect(calls).toBe(1);
    expect(os.characters.get(1)).toMatchObject({ palette: 3, repeat: 0 });
  });
});
