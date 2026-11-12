import { describe, expect, it } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import {
  applyPendingAckMessage,
  clearPendingAck,
  pendingAckChange,
  pendingAckOf,
  setPendingAck,
  subscribePendingAck,
} from '../src/office/pendingAck.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floor(): OfficeLayout {
  return {
    version: 1,
    cols: 6,
    rows: 4,
    tiles: new Array<TileType>(24).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

describe('pendingAckChange', () => {
  it('starts a pending ack on every live turn end (Stop or a question to the user) and on a permission prompt', () => {
    expect(pendingAckChange({ type: 'agentStatus', status: 'waiting', awaitingInput: true })).toBe(
      'waiting',
    );
    expect(pendingAckChange({ type: 'agentStatus', status: 'waiting', awaitingInput: false })).toBe(
      'waiting',
    );
    expect(pendingAckChange({ type: 'agentToolPermission' })).toBe('permission');
  });

  it('ignores the waiting status a connect replays (no awaitingInput field)', () => {
    expect(pendingAckChange({ type: 'agentStatus', status: 'waiting' })).toBeNull();
  });

  it('clears it when the agent moves on: a turn or a tool starts, or the prompt is answered', () => {
    expect(pendingAckChange({ type: 'agentStatus', status: 'active' })).toBe('clear');
    expect(pendingAckChange({ type: 'agentToolStart' })).toBe('clear');
    expect(pendingAckChange({ type: 'agentToolPermissionClear' })).toBe('clear');
    expect(pendingAckChange({ type: 'agentToolsClear' })).toBe('clear');
  });

  it('keeps it through a tool replayed awaiting permission or a background spawn re-sent', () => {
    expect(pendingAckChange({ type: 'agentToolStart', permissionActive: true })).toBeNull();
    expect(pendingAckChange({ type: 'agentToolStart', runInBackground: true })).toBeNull();
  });

  it('never rings for sub-agents or unrelated messages', () => {
    expect(pendingAckChange({ type: 'subagentToolPermission' })).toBeNull();
    expect(pendingAckChange({ type: 'agentToolDone' })).toBeNull();
  });
});

describe('pending ack store', () => {
  it('holds what each agent waits on until it is cleared, telling subscribers', () => {
    let calls = 0;
    const unsubscribe = subscribePendingAck(() => calls++);

    applyPendingAckMessage({ type: 'agentToolPermission', id: 7 });
    applyPendingAckMessage({ type: 'agentStatus', id: 8, status: 'waiting', awaitingInput: true });
    expect(pendingAckOf(7)).toBe('permission');
    expect(pendingAckOf(8)).toBe('waiting');
    expect(calls).toBe(2);

    // The same state again is no change.
    setPendingAck(7, 'permission');
    expect(calls).toBe(2);

    applyPendingAckMessage({ type: 'agentToolStart', id: 7 });
    clearPendingAck(8);
    expect(pendingAckOf(7)).toBeUndefined();
    expect(pendingAckOf(8)).toBeUndefined();
    expect(calls).toBe(4);

    // Clearing what isn't pending tells no one.
    clearPendingAck(8);
    expect(calls).toBe(4);
    unsubscribe();
  });

  it('ignores messages without an agent id', () => {
    applyPendingAckMessage({ type: 'agentToolPermission' });
    expect(pendingAckOf(0)).toBeUndefined();
  });
});

describe('acknowledging in the office', () => {
  it('a click on the character (dismissBubble) acknowledges it', () => {
    const os = new OfficeState(floor());
    os.addAgent(1);
    os.showPermissionBubble(1);
    setPendingAck(1, 'permission');
    os.dismissBubble(1);
    expect(pendingAckOf(1)).toBeUndefined();
    expect(os.characters.get(1)?.bubbleType).toBeNull();
  });

  it('a card tap (selectAndFollow) acknowledges it', () => {
    const os = new OfficeState(floor());
    os.addAgent(2);
    setPendingAck(2, 'waiting');
    os.selectAndFollow(2);
    expect(pendingAckOf(2)).toBeUndefined();
    expect(os.selectedAgentId).toBe(2);
  });
});
