/**
 * What an agentStatus does to its character: only a turn that ended for the
 * user rings (the done chime), stands the agent up and shows the check. A
 * connect's replay, a late idle report and a lead paused on its background
 * agents do none of that.
 *
 * Run with: npm test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { activityStateOf, activityText } from '../src/office/activityText.js';
import { applyAgentStatus } from '../src/office/agentStatusMessage.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState, TileType } from '../src/office/types.js';

beforeAll(() => {
  buildDynamicCatalog({
    catalog: [
      {
        id: 'TEST_CHAIR',
        label: 'chair',
        category: 'chairs',
        width: 16,
        height: 16,
        footprintW: 1,
        footprintH: 1,
        isDesk: false,
      },
    ],
    sprites: { TEST_CHAIR: [['c']] },
  });
});

function layoutWithChair(): OfficeLayout {
  return {
    version: 1,
    cols: 8,
    rows: 6,
    tiles: new Array<TileType>(48).fill(TileType.FLOOR_1),
    furniture: [{ uid: 'a', type: 'TEST_CHAIR', col: 1, row: 1 }],
  };
}

/** Run the office for `seconds` in 1/30 s frames. */
function run(os: OfficeState, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) os.update(1 / 30);
}

/** An agent at work in its chair. */
function working(): OfficeState {
  const os = new OfficeState(layoutWithChair());
  os.addAgent(1, undefined, undefined, 'a', true);
  os.setAgentActive(1, true);
  return os;
}

describe('applyAgentStatus', () => {
  it('a turn that ended for the user rings, stands the agent up and shows the check', () => {
    const os = working();
    const rang = applyAgentStatus(os, { id: 1, status: 'waiting', awaitingInput: false });
    run(os, 0.1);
    expect(rang).toBe(true);
    expect(os.characters.get(1)?.state).toBe(CharacterState.IDLE);
    expect(os.characters.get(1)?.bubbleType).toBe('waiting');
  });

  it("a connect's replay neither rings nor animates a turn end", () => {
    const os = working();
    const rang = applyAgentStatus(os, { id: 1, status: 'waiting', silent: true });
    run(os, 1);
    const ch = os.characters.get(1)!;
    expect(rang).toBe(false);
    expect(ch.isActive).toBe(false);
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(ch.bubbleType).toBeNull();
  });

  it('a replayed question keeps its mark, silently', () => {
    const os = working();
    const rang = applyAgentStatus(os, {
      id: 1,
      status: 'waiting',
      awaitingInput: true,
      silent: true,
    });
    expect(rang).toBe(false);
    expect(os.characters.get(1)?.bubbleType).toBe('waiting');
    expect(os.characters.get(1)?.waitingAwaitingInput).toBe(true);
  });

  it('a late idle report ending a turn the office thought live is silent', () => {
    const os = working();
    const rang = applyAgentStatus(os, {
      id: 1,
      status: 'waiting',
      awaitingInput: false,
      silent: true,
    });
    run(os, 1);
    expect(rang).toBe(false);
    expect(os.characters.get(1)?.state).toBe(CharacterState.TYPE);
  });

  it('a lead paused on its background agents stays seated and says what it waits on', () => {
    const os = working();
    const rang = applyAgentStatus(os, {
      id: 1,
      status: 'waiting',
      awaitingInput: false,
      pausedForSpawns: 2,
    });
    run(os, 1);
    const ch = os.characters.get(1)!;
    expect(rang).toBe(false);
    expect(ch.state).toBe(CharacterState.TYPE);
    expect(activityText(activityStateOf(ch, undefined, undefined))).toBe(
      'Waiting on 2 background agents',
    );

    // Back to work, then the real end: the pause is gone and it rings.
    applyAgentStatus(os, { id: 1, status: 'active' });
    expect(ch.pausedForSpawns).toBeUndefined();
    expect(applyAgentStatus(os, { id: 1, status: 'waiting', awaitingInput: false })).toBe(true);
  });
});
