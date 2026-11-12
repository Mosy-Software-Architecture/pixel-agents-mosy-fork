import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dressAgent } from '../src/agentCharacter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import { readConfig } from '../src/configPersistence.js';
import { conversationLook } from '../src/conversations.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { getPaletteCount } from '../src/paletteAssigner.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

/**
 * setAgentCharacter: dressing a running agent (the roster's Wear button). Each test has
 * its own $HOME, so the standalone state, config.json (the roster's recency) and
 * conversations.json (a session's remembered look) are written to a temp dir.
 */
describe('setAgentCharacter: dressing a running agent', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let broadcasts: Array<Record<string, unknown>>;
  let runtime: AgentRuntime | undefined;

  function agent(id: number, overrides: Partial<AgentState> = {}): AgentState {
    const jsonlFile = path.join(tempHome, `${id}.jsonl`);
    fs.writeFileSync(jsonlFile, '');
    const created = createAgentState({
      id,
      sessionId: id === 1 ? SESSION_A : SESSION_B,
      projectDir: tempHome,
      jsonlFile,
      isExternal: true,
      ...overrides,
    });
    store.set(id, created);
    return created;
  }

  function send(msg: Record<string, unknown>, privileged = true): void {
    handleClientMessage(msg, () => {}, { store, cache: null, privileged });
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-dress-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message as Record<string, unknown>));
  });

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    store.dispose();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('dresses an adopted agent and tells every office through the looks message', () => {
    agent(1, { palette: 0, repeat: 0 });

    send({ type: 'setAgentCharacter', id: 1, palette: 3 });

    expect(store.get(1)).toMatchObject({ palette: 3, repeat: 0 });
    const loaded = broadcasts.find((m) => m.type === 'characterProfilesLoaded');
    expect(loaded?.agentLooks).toEqual([{ id: 1, palette: 3, repeat: 0 }]);
    // the cast itself is unchanged (an office takes it as its own echo), with no saveId
    expect(loaded?.saveId).toBeUndefined();
    expect(Array.isArray(loaded?.profiles)).toBe(true);
  });

  it('wears a character someone else wears as its next repeat', () => {
    agent(1, { palette: 0, repeat: 0 });
    agent(2, { palette: 3, repeat: 0 });

    expect(dressAgent(store, 1, 3)).toEqual([{ id: 1, palette: 3, repeat: 1 }]);
  });

  it('moves the character to the front of the roster', () => {
    agent(1, { palette: 0, repeat: 0 });

    send({ type: 'setAgentCharacter', id: 1, palette: 4 });

    expect(readConfig().recentCharacters[0]).toBe(4);
    expect(broadcasts.some((m) => m.type === 'recentCharactersLoaded')).toBe(true);
  });

  it("dresses the agent's followers too: they copy their Lead's look", () => {
    agent(1, { palette: 0, repeat: 0 });
    agent(2, { palette: 0, repeat: 0, leadAgentId: 1, agentName: 'helper' });

    expect(dressAgent(store, 1, 2)).toEqual([
      { id: 1, palette: 2, repeat: 0 },
      { id: 2, palette: 2, repeat: 0 },
    ]);
    expect(store.get(2)).toMatchObject({ palette: 2, repeat: 0 });
  });

  it("refuses an agent that copies its Lead's look", () => {
    agent(1, { palette: 0, repeat: 0 });
    agent(2, { palette: 0, repeat: 0, leadAgentId: 1, agentName: 'helper' });

    expect(dressAgent(store, 2, 4)).toBeNull();
    expect(store.get(2)).toMatchObject({ palette: 0, repeat: 0 });
  });

  it('ignores an unknown agent, a palette outside the cast, and the character already worn', () => {
    agent(1, { palette: 1, repeat: 0 });

    expect(dressAgent(store, 9, 2)).toBeNull();
    expect(dressAgent(store, 1, getPaletteCount())).toBeNull();
    expect(dressAgent(store, 1, -1)).toBeNull();
    expect(dressAgent(store, 1, 1.5)).toBeNull();
    expect(dressAgent(store, '1', 2)).toBeNull();
    expect(dressAgent(store, 1, 1)).toBeNull();
    expect(store.get(1)).toMatchObject({ palette: 1, repeat: 0 });
  });

  it('broadcasts nothing when nothing changed', () => {
    agent(1, { palette: 1, repeat: 0 });

    send({ type: 'setAgentCharacter', id: 1, palette: 1 });

    expect(broadcasts).toEqual([]);
  });

  it('an untokened client cannot dress an agent', () => {
    agent(1, { palette: 0, repeat: 0 });

    send({ type: 'setAgentCharacter', id: 1, palette: 3 }, false);

    expect(store.get(1)?.palette).toBe(0);
    expect(broadcasts).toEqual([]);
  });

  it("updates the agent's saved seat and its session's remembered look", () => {
    agent(1, { palette: 0, repeat: 0 });
    store.getAdapter()!.saveSeats({ '1': { palette: 0, repeat: 0, seatId: 'chair-7' } });

    dressAgent(store, 1, 5);

    expect(store.getAdapter()!.loadSeats()['1']).toEqual({
      palette: 5,
      repeat: 0,
      seatId: 'chair-7',
    });
    // a resumed conversation comes back wearing it, in its seat
    expect(conversationLook(SESSION_A)).toMatchObject({ palette: 5, repeat: 0, seatId: 'chair-7' });
  });

  it('keeps the new character across a persist and restore (a reload, a later resume)', () => {
    agent(1, { palette: 0, repeat: 0 });
    agent(2, { palette: 2, repeat: 0 });
    dressAgent(store, 1, 2);
    expect(store.get(1)).toMatchObject({ palette: 2, repeat: 1 });

    // a fresh process over the same state file
    const restored = new AgentStateStore();
    restored.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(restored, claudeProvider);
    runtime.restoreExternalAgents();

    expect(restored.get(1)).toMatchObject({ palette: 2, repeat: 1 });
    expect(restored.get(2)).toMatchObject({ palette: 2, repeat: 0 });
  });
});
