import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CHARACTER_PROFILES } from '../../core/src/defaultCharacterProfiles.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import { getHooksEnabled, readConfig, setHooksEnabled } from '../src/configPersistence.js';
import { MAX_CHARACTER_REPEAT, TERMINAL_REQUIRES_TOKEN_REASON } from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { getPaletteCount, setExternalCharacterCount } from '../src/paletteAssigner.js';
import {
  claudeProvider,
  disableClaudeAgentsList,
  enableClaudeAgentsList,
} from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';
import type { AgentState } from '../src/types.js';

/** Let the setHooksEnabled dispatch's async chain (side effect →
 *  areHooksInstalled → persist → send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundSpawns: new Map(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/**
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting $HOME to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  // Tokened by default: these suites pin what a message DOES; the read-only
  // gate for untokened clients has its own suite below.
  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache, privileged: true };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── hooksStatus (actual install state, not the hooksEnabled setting) ──

  describe('hooksStatus', () => {
    it('webviewReady reports installed: false when no hooks are in settings.json', async () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      // The provider check is async; the message lands after the sync handshake.
      await new Promise((r) => setTimeout(r, 0));

      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });

    it('setHooksEnabled reports the actual outcome after the side effect settles', async () => {
      let sideEffectRan = false;
      ctx.privileged = true;
      ctx.onSetHooksEnabled = async () => {
        sideEffectRan = true;
      };
      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(true);
      // The side effect installed nothing (stub), so the truthful answer is false
      // even though the user just toggled the setting ON.
      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });
  });

  // ── setHooksEnabled: preference vs reality ───────────────────

  describe('setHooksEnabled persistence', () => {
    /** Put our command on every installed event, as a real install would. */
    function seedInstalledHooks(): void {
      const command = `node "${path.join(tempHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
      const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
      fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
        }),
      );
    }

    // THE stranding bug: the preference was written BEFORE the uninstall, so a
    // failed removal left the entries on disk and still firing while the
    // persisted hooks-off made the next startup skip the consent/install path
    // entirely — never asked again, no route left to remove them.
    it('does not persist hooks-off when the uninstall failed', async () => {
      seedInstalledHooks();
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: settings.json still carries our entries */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: false },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      // The preference still says ON, so the next startup re-runs the install
      // path and the user keeps a way to turn hooks off.
      expect(getHooksEnabled('claude')).toBe(true);
      // ...and the checkbox is told the truth: they are still installed.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // The mirror case: an install that did not happen must not persist ON.
    it('does not persist hooks-on when the install failed', async () => {
      setHooksEnabled('claude', false);
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays empty */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
    });

    // The happy path still persists, or the toggle would do nothing at all.
    it('persists the preference when the outcome matches the request', async () => {
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => seedInstalledHooks();

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // A non-local client (LAN peer, rebound page) never reaches the side effect
    // at all: granting consent to modify ~/.claude/settings.json is not a
    // decision a remote peer gets to make. See httpServerWs.test.ts.
    it('ignores the toggle entirely when the client is not privileged', async () => {
      let sideEffectRan = false;
      ctx.privileged = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(getHooksEnabled('claude')).toBe(true);
      // It still hears the truth, so a LAN viewer's checkbox shows reality
      // rather than appearing to have worked.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('replays agent activity after layoutLoaded so it lands on real characters', () => {
      // Two things at once, both invisible to the helper's own unit tests:
      // that handleWebviewReady calls the replay at all, and that it runs AFTER
      // layoutLoaded. The characters the replay targets only exist once the
      // layout flush creates them, so an earlier replay is silently dropped and
      // a reconnecting client shows a working agent as Idle.
      store.set(1, createTestAgent({ id: 1, isWaiting: true }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iLayout = types.indexOf('layoutLoaded');
      const iStatus = types.indexOf('agentStatus');

      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iStatus).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeLessThan(iStatus);

      expect(sent[iStatus]).toMatchObject({ type: 'agentStatus', id: 1, status: 'waiting' });
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: { characters: [] },
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: { characters: [] },
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: saveAgentSeats palette sync', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  // Tokened by default: these suites pin what a message DOES; the read-only
  // gate for untokened clients has its own suite below.
  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache, privileged: true };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-seats-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('fills in the look of an agent that has none', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '1': { palette: 4, repeat: 120, seatId: 'seat-a' } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(4);
    expect(store.get(1)?.repeat).toBe(120);
  });

  it('never replaces a look the server already gave the agent', () => {
    // A browser that reconnects keeps the looks it had before and saves them
    // back; they must not overwrite what the server assigned meanwhile.
    store.set(2, createTestAgent({ id: 2, palette: 0, repeat: 0 }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '2': { palette: 2, repeat: 60, seatId: 'seat-b' } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(2)?.palette).toBe(0);
    expect(store.get(2)?.repeat).toBe(0);
  });

  it('drops an out-of-range palette', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '1': { palette: 99, repeat: 50, seatId: null } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBeUndefined();
    // repeat 50 is in range → still filled.
    expect(store.get(1)?.repeat).toBe(50);
  });

  it('drops a negative repeat', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '1': { palette: 2, repeat: -5, seatId: null } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.repeat).toBeUndefined();
  });

  it('drops a non-integer palette', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      { type: 'saveAgentSeats', seats: { '1': { palette: 2.5, repeat: 90, seatId: null } } },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBeUndefined();
    expect(store.get(1)?.repeat).toBe(90);
  });

  it('accepts the upper repeat boundary and lower palette boundary (0)', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 0, repeat: MAX_CHARACTER_REPEAT, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(0);
    expect(store.get(1)?.repeat).toBe(MAX_CHARACTER_REPEAT);
  });

  it('silently skips seat entries for unknown agent ids', () => {
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '999': { palette: 3, repeat: 100, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(999)).toBeUndefined();
  });

  it('accepts palette 7 when 6 profiles and 2 external sprites make 8 palettes', () => {
    // The guard reads the palette count (character profiles + external
    // char_N.png sprites) instead of hardcoding 6. With 8, palette 7 is valid.
    setExternalCharacterCount(2);
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 7, repeat: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(7);
    // palette 8 is still out of range for 8 palettes → dropped.
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 8, repeat: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );
    expect(store.get(1)?.palette).toBe(7);
    setExternalCharacterCount(0);
  });
});

describe('clientMessageHandler: character profiles', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  const profilesFile = () => path.join(tempHome, '.pixel-agents', 'characters.json');
  const ctx = (): ClientMessageContext => ({ store, cache: null, privileged: true });

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-profiles-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('webviewReady sends the six default profiles when none are saved', () => {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx());
    const loaded = sent.find((m) => m.type === 'characterProfilesLoaded');
    expect(loaded?.profiles).toEqual(DEFAULT_CHARACTER_PROFILES);
    // profiles come before any character sprites
    const order = sent.map((m) => m.type);
    expect(order.indexOf('characterProfilesLoaded')).toBeLessThan(order.indexOf('layoutLoaded'));
  });

  it('saveCharacterProfiles persists, broadcasts with its saveId and moves the palette count', () => {
    const profiles = [
      { id: 'a', name: 'A', body: 'flat', v: 35 },
      { id: 'b', name: 'B', body: 'bust', hair: 'bob', v: 35 },
      { id: 'c', name: 'C', body: 'flat', v: 35 },
    ];
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles, saveId: 's1' },
      (m) => sent.push(m),
      ctx(),
    );

    expect(JSON.parse(fs.readFileSync(profilesFile(), 'utf-8'))).toEqual(profiles);
    expect(broadcasts).toContainEqual({
      type: 'characterProfilesLoaded',
      profiles,
      items: [],
      saveId: 's1',
    });
    // the answer is the broadcast; the sender gets no second, private copy
    expect(sent.filter((m) => m.type === 'characterProfilesLoaded')).toEqual([]);
    expect(getPaletteCount()).toBe(3);

    // the next client gets the saved list, with no saveId (it answers no save)
    sent = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx());
    expect(sent.find((m) => m.type === 'characterProfilesLoaded')).toEqual({
      type: 'characterProfilesLoaded',
      profiles,
      items: [],
    });
  });

  it('a valid current-format save round-trips byte-identically into the broadcast', () => {
    /* eslint-disable pixel-agents/no-inline-colors -- pixel edits are hex data, not UI colours */
    const profiles = [
      ...DEFAULT_CHARACTER_PROFILES,
      {
        id: 'edited',
        name: 'Edited',
        body: 'bust',
        eyeShape: 'lidded',
        eyeRows: 'both',
        hair: 'bob',
        top: 'tshirt',
        colors: {
          skin: { h: 0, s: 0, b: 0, c: 0, palette: 'Tan' },
          hair: { h: 210.5, s: -12, b: 4, c: 0, colorize: true },
        },
        edits: {
          'top:tshirt': { cells: { '0': { '17': '#a1B2c3', '18': null } } },
          'body:bust': { cells: { '20': { '511': '#000000' } } },
        },
        futureField: { kept: [1, 2] },
        v: 35,
      },
    ];
    /* eslint-enable pixel-agents/no-inline-colors */
    const sentJson = JSON.stringify(profiles);
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles: JSON.parse(sentJson), saveId: 'rt' },
      (m) => sent.push(m),
      ctx(),
    );
    const echo = broadcasts.find((m) => m.type === 'characterProfilesLoaded');
    expect(echo?.saveId).toBe('rt');
    expect(JSON.stringify(echo?.profiles)).toBe(sentJson);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(profilesFile(), 'utf-8')))).toBe(sentJson);
  });

  it("saves the wardrobe artifact's v30 profiles migrated (renamed bodies, eye shapes and parts)", () => {
    const profiles = [
      {
        body: 'light_female',
        eyeShape: 'light_male',
        hair: 'layer_21',
        edits: {
          'body:light_female': { rev: 1, cells: {} },
          'lashes:light_male': { rev: 1, cells: {} },
          'lashes:closed': { rev: 1, cells: {} },
          'hair:layer_21': { rev: 1, cells: {} },
        },
        v: 30,
      },
    ];
    const migrated = [
      {
        id: 'char-0',
        body: 'bust',
        eyeShape: 'plain',
        hair: 'mop',
        edits: {
          'body:bust': { cells: {} },
          'lashes:plain': { cells: {} },
          'lashes:closed': { cells: {} },
          'hair:mop': { cells: {} },
        },
        v: 35,
      },
    ];
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles, saveId: 'v30' },
      (m) => sent.push(m),
      ctx(),
    );
    expect(JSON.parse(fs.readFileSync(profilesFile(), 'utf-8'))).toEqual(migrated);
    // the broadcast is what was persisted, not what was sent
    expect(broadcasts).toContainEqual({
      type: 'characterProfilesLoaded',
      profiles: migrated,
      items: [],
      saveId: 'v30',
    });
  });

  it('answers a refused save to the sender alone, with the saved list and its saveId', () => {
    const saved = [{ id: 'kept', name: 'Kept', body: 'flat', v: 35 }];
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles: saved, saveId: 'ok' },
      (m) => sent.push(m),
      ctx(),
    );
    broadcasts = [];
    const refused = [
      [],
      [{ name: 'no body' }],
      'nope',
      [{ body: 'flat', colors: [] }],
      [{ body: 'flat', colors: { hair: 'red' } }],
      [{ body: 'flat', edits: { 'top:x': { rev: 1, cells: { '0': null } } } }],
    ];
    refused.forEach((profiles, i) => {
      handleClientMessage(
        { type: 'saveCharacterProfiles', profiles, saveId: `bad${i}` },
        (m) => sent.push(m),
        ctx(),
      );
    });
    expect(JSON.parse(fs.readFileSync(profilesFile(), 'utf-8'))).toEqual(saved);
    expect(broadcasts.filter((m) => m.type === 'characterProfilesLoaded')).toEqual([]);
    expect(sent.filter((m) => m.type === 'characterProfilesLoaded')).toEqual(
      refused.map((_, i) => ({
        type: 'characterProfilesLoaded',
        profiles: saved,
        items: [],
        saveId: `bad${i}`,
      })),
    );
  });

  it('answers a save whose write fails with the defaults still in effect', () => {
    // A directory where the file should be: the rename fails.
    fs.mkdirSync(profilesFile(), { recursive: true });
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles: [{ body: 'flat' }], saveId: 'w' },
      (m) => sent.push(m),
      ctx(),
    );
    expect(broadcasts.filter((m) => m.type === 'characterProfilesLoaded')).toEqual([]);
    expect(sent.find((m) => m.type === 'characterProfilesLoaded')).toEqual({
      type: 'characterProfilesLoaded',
      profiles: DEFAULT_CHARACTER_PROFILES,
      items: [],
      saveId: 'w',
    });
  });

  it('an untokened client cannot save profiles', () => {
    const profiles = [{ body: 'flat' }];
    handleClientMessage(
      { type: 'saveCharacterProfiles', profiles, saveId: 'x' },
      (m) => sent.push(m),
      { store, cache: null, privileged: false },
    );
    expect(fs.existsSync(profilesFile())).toBe(false);
    expect(broadcasts.filter((m) => m.type === 'characterProfilesLoaded')).toEqual([]);
    // refused like any other save: the sender is told the list still in effect
    expect(sent).toContainEqual({
      type: 'characterProfilesLoaded',
      profiles: DEFAULT_CHARACTER_PROFILES,
      items: [],
      saveId: 'x',
    });
  });
});

/**
 * Terminal control plane: how the handler wires PtySessionManager into the
 * protocol. The data plane (frames over /terminal/:agentId) is covered by
 * terminalRoutes.test.ts; the launch mechanics by standaloneAgentLauncher.
 * test.ts. What's asserted here is the dispatch glue: availability broadcast
 * on webviewReady, live-session re-announcement for reloading browsers, and
 * launch/close routing.
 */
describe('clientMessageHandler: standalone terminal control plane', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  class FakePty implements IPty {
    readonly pid = 4242;
    killSignals: Array<string | undefined> = [];
    onData(): void {}
    onExit(): void {}
    write(): void {}
    resize(): void {}
    kill(signal?: string): void {
      this.killSignals.push(signal);
    }
  }

  function workingPtyManager(): {
    manager: PtySessionManager;
    spawned: FakePty[];
    spawnArgs: string[][];
  } {
    const spawned: FakePty[] = [];
    const spawnArgs: string[][] = [];
    const module: PtyModule = {
      spawn: (_file, args) => {
        spawnArgs.push([...args]);
        const pty = new FakePty();
        spawned.push(pty);
        return pty;
      },
    };
    const manager = new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
    return { manager, spawned, spawnArgs };
  }

  /** Minimal store agent; only identity fields matter to the control plane. */
  function makeAgent(id: number): AgentState {
    return {
      id,
      sessionId: `session-${id}`,
      terminalRef: undefined,
      isExternal: false,
      projectDir: path.join(tempHome, 'nowhere'),
      jsonlFile: path.join(tempHome, 'nowhere', `session-${id}.jsonl`),
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundSpawns: new Map(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: 200_000,
      providerId: 'claude',
    };
  }

  /** Tokened connection by default -- the terminal is a privileged surface, so
   *  every happy path below is what a client that opened the CLI's URL sees.
   *  The untokened cases pass `privileged: false` explicitly. */
  function ctx(overrides: Partial<ClientMessageContext> = {}): ClientMessageContext {
    return { store, cache: null, privileged: true, ...overrides };
  }

  function dispatch(msg: Record<string, unknown>, context: ClientMessageContext): void {
    handleClientMessage(msg, (m) => sent.push(m), context);
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-term-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    sent = [];
    broadcasts = [];
    store.on('broadcast', (message) => broadcasts.push(message));
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    runtime.dispose();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── webviewReady: availability ───────────────────────────────

  it('webviewReady announces terminal availability after capabilities, before existingAgents', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const types = sent.map((m) => m.type);
    const availabilityIndex = types.indexOf('terminalAvailability');
    expect(sent[availabilityIndex]).toEqual({
      type: 'terminalAvailability',
      available: true,
      reason: undefined,
    });
    expect(availabilityIndex).toBeGreaterThan(types.indexOf('providerCapabilities'));
    expect(availabilityIndex).toBeLessThan(types.indexOf('existingAgents'));
  });

  it('webviewReady reports the unavailable reason (e.g. --no-terminal)', () => {
    const manager = PtySessionManager.disabled('Terminal disabled with --no-terminal.');

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    expect(sent).toContainEqual({
      type: 'terminalAvailability',
      available: false,
      reason: 'Terminal disabled with --no-terminal.',
    });
  });

  it('webviewReady tells an untokened client the terminal is unavailable, and why', () => {
    const { manager } = workingPtyManager();
    store.set(1, makeAgent(1));
    manager.create({ agentId: 1, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager, privileged: false }));

    expect(sent).toContainEqual({
      type: 'terminalAvailability',
      available: false,
      reason: TERMINAL_REQUIRES_TOKEN_REASON,
    });
    // No drawer tab to rebuild: the client could not attach to it anyway.
    expect(sent.map((m) => m.type)).not.toContain('terminalSessionOpened');
  });

  it('webviewReady omits every terminal message without a ptyManager (VS Code mode)', () => {
    store.set(1, makeAgent(1));

    dispatch({ type: 'webviewReady' }, ctx());

    const types = sent.map((m) => m.type);
    expect(types).not.toContain('terminalAvailability');
    expect(types).not.toContain('terminalSessionOpened');
  });

  // ── webviewReady: live-session re-announcement ───────────────

  it('webviewReady re-announces live terminals after existingAgents, and only those', () => {
    const { manager } = workingPtyManager();
    store.set(1, makeAgent(1));
    store.set(2, makeAgent(2));
    manager.create({ agentId: 1, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const opened = sent.filter((m) => m.type === 'terminalSessionOpened');
    expect(opened).toEqual([{ type: 'terminalSessionOpened', agentId: 1 }]);
    const types = sent.map((m) => m.type);
    expect(types.indexOf('terminalSessionOpened')).toBeGreaterThan(types.indexOf('existingAgents'));
  });

  it('webviewReady re-announces whether a terminal scrolls by wheel reports', () => {
    const { manager } = workingPtyManager();
    store.set(1, { ...makeAgent(1), wheelReports: true });
    manager.create({ agentId: 1, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    expect(sent.filter((m) => m.type === 'terminalSessionOpened')).toEqual([
      { type: 'terminalSessionOpened', agentId: 1, wheelReports: true },
    ]);
  });

  // ── launchAgent ──────────────────────────────────────────────

  it('launchAgent spawns a PTY-backed agent and announces its terminal', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager }));

    expect(store.size).toBe(1);
    const id = [...store][0][0];
    expect(manager.has(id)).toBe(true);
    expect(broadcasts).toContainEqual({
      type: 'terminalSessionOpened',
      agentId: id,
      wheelReports: true,
    });
  });

  it('launchAgent with a roster pick moves it to the front of the roster', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'launchAgent', palette: 2 }, ctx({ runtime, ptyManager: manager }));

    expect(store.size).toBe(1);
    expect(readConfig().recentCharacters).toEqual([2]);
    expect(broadcasts).toContainEqual(expect.objectContaining({ type: 'recentCharactersLoaded' }));
  });

  it('launchAgent records no recency when the launch fails', () => {
    // No agent wears the pick, so it must not jump to the front of every
    // office's roster.
    const manager = PtySessionManager.disabled('Terminal disabled with --no-terminal.');

    dispatch({ type: 'launchAgent', palette: 2 }, ctx({ runtime, ptyManager: manager }));

    expect(store.size).toBe(0);
    expect(readConfig().recentCharacters ?? []).toEqual([]);
    expect(broadcasts.filter((m) => m.type === 'recentCharactersLoaded')).toEqual([]);
  });

  it('launchAgent is ignored from an untokened client', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager, privileged: false }));

    expect(store.size).toBe(0);
    expect(broadcasts).toHaveLength(0);
  });

  it('launchAgent applies the persisted permission posture, not a per-launch field', () => {
    const { manager, spawnArgs } = workingPtyManager();

    // Posture off: no flag, and a stale client field cannot turn it on — the
    // launch message carries no bypass field any more.
    dispatch(
      { type: 'launchAgent', bypassPermissions: true },
      ctx({ runtime, ptyManager: manager }),
    );
    expect(spawnArgs[0]).not.toContain('--dangerously-skip-permissions');

    // Posture on: every launch gets the flag without the client saying so.
    dispatch({ type: 'setBypassPermissions', enabled: true }, ctx());
    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager }));
    expect(spawnArgs[1]).toContain('--dangerously-skip-permissions');
  });

  it('setBypassPermissions persists via the adapter (standalone namespace)', () => {
    dispatch({ type: 'setBypassPermissions', enabled: true }, ctx());
    const adapter = store.getAdapter()!;
    expect(adapter.getSetting('pixel-agents.bypassPermissions', false)).toBe(true);

    dispatch({ type: 'setBypassPermissions', enabled: false }, ctx());
    expect(adapter.getSetting('pixel-agents.bypassPermissions', true)).toBe(false);
  });

  it('setBypassPermissions publishes the accepted posture to every connected office', () => {
    // Every launch reads the persisted posture, so an office still showing the
    // old value would be launching with a flag its Settings says is off.
    dispatch({ type: 'setBypassPermissions', enabled: true }, ctx());
    expect(broadcasts).toContainEqual({ type: 'bypassPermissionsUpdated', enabled: true });

    broadcasts = [];
    dispatch({ type: 'setBypassPermissions', enabled: false }, ctx());
    expect(broadcasts).toContainEqual({ type: 'bypassPermissionsUpdated', enabled: false });
  });

  it('refuses setBypassPermissions from an unprivileged client and tells it the truth', () => {
    // The escalation this pins: an untokened viewer (LAN, DNS-rebound page)
    // flips the posture, and the operator's NEXT launch from a tokened tab runs
    // with --dangerously-skip-permissions.
    const { manager, spawnArgs } = workingPtyManager();
    const runtime = new AgentRuntime(store, claudeProvider);

    dispatch({ type: 'setBypassPermissions', enabled: true }, ctx({ privileged: false }));

    expect(store.getAdapter()!.getSetting('pixel-agents.bypassPermissions', false)).toBe(false);
    // Nothing changed, so nothing is published to the other offices.
    expect(broadcasts.filter((m) => m.type === 'bypassPermissionsUpdated')).toEqual([]);
    // The optimistic toggle snaps back: the refused client gets the real value.
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'settingsLoaded', bypassPermissions: false }),
    );
    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager }));
    expect(spawnArgs[0]).not.toContain('--dangerously-skip-permissions');
  });

  it('webviewReady reports the persisted permission posture in settingsLoaded', () => {
    dispatch({ type: 'setBypassPermissions', enabled: true }, ctx());
    sent = [];

    dispatch({ type: 'webviewReady' }, ctx());

    const settings = sent.find((m) => m.type === 'settingsLoaded');
    expect(settings?.bypassPermissions).toBe(true);
  });

  // ── Show Directory Names ─────────────────────────────────────

  it('shows Directory names by default, and persists the choice next to the other settings', () => {
    dispatch({ type: 'webviewReady' }, ctx());
    expect(sent.find((m) => m.type === 'settingsLoaded')?.showDirectoryNames).toBe(true);

    dispatch({ type: 'setShowDirectoryNames', enabled: false }, ctx());
    expect(readConfig().standalone.showDirectoryNames).toBe(false);
    sent = [];
    dispatch({ type: 'webviewReady' }, ctx());
    expect(sent.find((m) => m.type === 'settingsLoaded')?.showDirectoryNames).toBe(false);

    // junk is ignored
    dispatch({ type: 'setShowDirectoryNames', enabled: 'yes' }, ctx());
    expect(readConfig().standalone.showDirectoryNames).toBe(false);
  });

  it('refuses setShowDirectoryNames from an unprivileged client and tells it the truth', () => {
    dispatch({ type: 'setShowDirectoryNames', enabled: false }, ctx({ privileged: false }));

    expect(readConfig().standalone.showDirectoryNames).toBe(true);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'settingsLoaded', showDirectoryNames: true }),
    );
  });

  // ── webviewReady: the host's own Directory ───────────────────

  it('webviewReady lists no host Directory while Show Start Directory is off (the default)', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const directories = sent.find((m) => m.type === 'directoriesLoaded');
    expect(directories?.directories).toEqual([]);
    const settings = sent.find((m) => m.type === 'settingsLoaded');
    expect(settings?.showHostDirectories).toBe(false);
  });

  it('webviewReady contributes the server start directory as a host Directory when shown', () => {
    const { manager } = workingPtyManager();
    store.getAdapter()!.setSetting('pixel-agents.showHostDirectories', true);

    dispatch({ type: 'webviewReady' }, ctx({ ptyManager: manager }));

    const directories = sent.find((m) => m.type === 'directoriesLoaded');
    expect(directories?.directories).toEqual([
      { name: path.basename(process.cwd()), path: process.cwd(), source: 'host' },
    ]);
    const settings = sent.find((m) => m.type === 'settingsLoaded');
    expect(settings?.showHostDirectories).toBe(true);
  });

  it('setShowHostDirectories persists and rebroadcasts the list to every office', () => {
    const { manager } = workingPtyManager();
    const host = { name: path.basename(process.cwd()), path: process.cwd(), source: 'host' };

    dispatch({ type: 'setShowHostDirectories', enabled: true }, ctx({ ptyManager: manager }));
    expect(store.getAdapter()!.getSetting('pixel-agents.showHostDirectories', false)).toBe(true);
    expect(broadcasts).toEqual([{ type: 'directoriesLoaded', directories: [host] }]);

    broadcasts = [];
    dispatch({ type: 'setShowHostDirectories', enabled: false }, ctx({ ptyManager: manager }));
    expect(store.getAdapter()!.getSetting('pixel-agents.showHostDirectories', true)).toBe(false);
    expect(broadcasts).toEqual([{ type: 'directoriesLoaded', directories: [] }]);
  });

  it('toggling Show Start Directory never empties the conversation sidebar', () => {
    const { manager } = workingPtyManager();
    const conversationDirs = () => {
      sent = [];
      dispatch({ type: 'requestConversations' }, ctx({ ptyManager: manager }));
      const loaded = sent.find((m) => m.type === 'conversationsLoaded');
      return (loaded?.directories as Array<{ path: string }>).map((d) => d.path);
    };

    for (const enabled of [true, false, true, false]) {
      dispatch({ type: 'setShowHostDirectories', enabled }, ctx({ ptyManager: manager }));
      // the drawer follows the setting...
      const drawer = broadcasts.at(-1)?.directories as unknown[];
      expect(drawer).toHaveLength(enabled ? 1 : 0);
      // ...the sidebar keeps grouping the start directory's sessions
      expect(conversationDirs()).toEqual([process.cwd()]);
    }
  });

  it('hiding the host Directories leaves user-defined ones listed', () => {
    const { manager } = workingPtyManager();
    const target = path.join(tempHome, 'side-project');
    fs.mkdirSync(target);
    dispatch(
      { type: 'saveDirectory', name: 'Side Project', path: target },
      ctx({ ptyManager: manager }),
    );
    broadcasts = [];

    dispatch({ type: 'setShowHostDirectories', enabled: false }, ctx({ ptyManager: manager }));

    expect(broadcasts).toEqual([
      {
        type: 'directoriesLoaded',
        directories: [{ name: 'Side Project', path: target, source: 'user' }],
      },
    ]);
  });

  it('refuses setShowHostDirectories from an unprivileged client and tells it the truth', () => {
    const { manager } = workingPtyManager();

    dispatch(
      { type: 'setShowHostDirectories', enabled: true },
      ctx({ ptyManager: manager, privileged: false }),
    );

    expect(store.getAdapter()!.getSetting('pixel-agents.showHostDirectories', false)).toBe(false);
    expect(broadcasts.filter((m) => m.type === 'directoriesLoaded')).toEqual([]);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'settingsLoaded', showHostDirectories: false }),
    );
  });

  it('webviewReady contributes no Directory without a ptyManager (VS Code mode)', () => {
    dispatch({ type: 'webviewReady' }, ctx());

    expect(sent.map((m) => m.type)).not.toContain('directoriesLoaded');
  });

  // ── user-defined Directories ─────────────────────────────────

  it('saveDirectory persists and rebroadcasts the union to every office', () => {
    const { manager } = workingPtyManager();
    const target = path.join(tempHome, 'side-project');
    fs.mkdirSync(target);

    dispatch(
      { type: 'saveDirectory', name: 'Side Project', path: target },
      ctx({ ptyManager: manager }),
    );

    // Every office gets the list; only the saver gets the ack, carrying the
    // entry as stored (its name keys the saver's Area mapping).
    expect(sent).toEqual([
      {
        type: 'directorySaved',
        directory: { name: 'Side Project', path: target, source: 'user' },
      },
    ]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].type).toBe('directoriesLoaded');
    expect(broadcasts[0].directories).toContainEqual({
      name: 'Side Project',
      path: target,
      source: 'user',
    });
    expect(readConfig().directories).toEqual([{ name: 'Side Project', path: target }]);
  });

  it('ignores every Directory message from an unprivileged client', () => {
    // saveDirectory's validation is an exists-oracle for any path, suggestions
    // list project paths, and both mutations rewrite the machine-wide config.
    const { manager } = workingPtyManager();
    const target = path.join(tempHome, 'side-project');
    fs.mkdirSync(target);
    const untokened = ctx({ ptyManager: manager, privileged: false });

    dispatch({ type: 'saveDirectory', name: 'Side Project', path: target }, untokened);
    dispatch({ type: 'saveDirectory', name: 'Probe', path: path.join(tempHome, 'x') }, untokened);
    dispatch({ type: 'removeDirectory', path: target }, untokened);
    dispatch({ type: 'requestDirectorySuggestions' }, untokened);

    expect(sent).toEqual([]);
    expect(broadcasts).toEqual([]);
    expect(readConfig().directories).toEqual([]);
  });

  it('refuses external asset directory changes from an unprivileged client', () => {
    // An asset directory is read from outside ~/.pixel-agents/ and its sprites
    // are sent back over the socket -- an untokened viewer must not choose it.
    const reloads: number[] = [];
    const untokened = ctx({ privileged: false, onReloadAssets: async () => void reloads.push(1) });
    const outside = path.join(tempHome, 'someone-elses-pictures');

    dispatch({ type: 'addExternalAssetDirectory', path: outside }, untokened);
    dispatch({ type: 'removeExternalAssetDirectory', path: outside }, untokened);

    expect(readConfig().externalAssetDirectories).toEqual([]);
    expect(reloads).toEqual([]);
    // Each refusal answers with the real (unchanged) list.
    expect(sent).toEqual([
      { type: 'externalAssetDirectoriesUpdated', dirs: [] },
      { type: 'externalAssetDirectoriesUpdated', dirs: [] },
    ]);
  });

  it('applies external asset directory changes from a privileged client', () => {
    const reloads: number[] = [];
    const tokened = ctx({ onReloadAssets: async () => void reloads.push(1) });
    const assets = path.join(tempHome, 'my-assets');

    dispatch({ type: 'addExternalAssetDirectory', path: assets }, tokened);
    expect(readConfig().externalAssetDirectories).toEqual([assets]);
    dispatch({ type: 'removeExternalAssetDirectory', path: assets }, tokened);
    expect(readConfig().externalAssetDirectories).toEqual([]);
    expect(reloads).toHaveLength(2);
  });

  it('saveDirectory with an invalid path replies directoryRejected and persists nothing', () => {
    const { manager } = workingPtyManager();
    const missing = path.join(tempHome, 'not-there');

    dispatch(
      { type: 'saveDirectory', name: 'Broken', path: missing },
      ctx({ ptyManager: manager }),
    );

    expect(broadcasts).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('directoryRejected');
    expect(sent[0].path).toBe(missing);
    expect(String(sent[0].reason)).toContain(missing);
    expect(readConfig().directories).toEqual([]);
  });

  it('removeDirectory drops the entry and rebroadcasts', () => {
    const { manager } = workingPtyManager();
    const target = path.join(tempHome, 'side-project');
    fs.mkdirSync(target);
    dispatch(
      { type: 'saveDirectory', name: 'Side Project', path: target },
      ctx({ ptyManager: manager }),
    );
    broadcasts = [];

    dispatch({ type: 'removeDirectory', path: target }, ctx({ ptyManager: manager }));

    expect(readConfig().directories).toEqual([]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].directories).not.toContainEqual(
      expect.objectContaining({ path: target }) as unknown,
    );
  });

  it('launchAgent with a directoryPath labels the agent with its Directory name', () => {
    const { manager, spawned } = workingPtyManager();
    const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-dir-')));
    try {
      dispatch(
        { type: 'saveDirectory', name: 'Side Project', path: target },
        ctx({ ptyManager: manager }),
      );

      dispatch(
        { type: 'launchAgent', directoryPath: target },
        ctx({ runtime, ptyManager: manager }),
      );

      expect(spawned).toHaveLength(1);
      const id = [...store][0][0];
      // Labelled with the Directory's NAME, not the launch path's basename:
      // that is what the user called it, and what its Area mapping is keyed by
      // (directoryAt in server/src/directories.ts).
      expect(store.get(id)?.directoryName).toBe('Side Project');
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('launchAgent falls back to the server cwd when no directoryPath is sent', () => {
    const { manager } = workingPtyManager();

    dispatch({ type: 'launchAgent' }, ctx({ runtime, ptyManager: manager }));

    const id = [...store][0][0];
    expect(store.get(id)?.directoryName).toBe(path.basename(process.cwd()));
  });

  it('launchAgent is ignored without a ptyManager', () => {
    dispatch({ type: 'launchAgent' }, ctx({ runtime }));

    expect(store.size).toBe(0);
    expect(broadcasts).toHaveLength(0);
  });

  // ── A session in Claude Code's background service ────────────

  describe('a session that runs in the background', () => {
    const sessionId = '7fdcf719-fd04-418f-b911-6a99f154c1e5';
    let workDir: string;

    beforeEach(() => {
      workDir = fs.realpathSync(fs.mkdtempSync(path.join(tempHome, 'work-')));
      const projectDir = claudeProvider.getSessionDirs!(workDir)[0];
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ type: 'ai-title', aiTitle: 'In the background' })}\n`,
      );
      // `claude agents --json` lists it: its worker runs (pid 25624).
      enableClaudeAgentsList(async () =>
        JSON.stringify([
          { pid: 25624, id: '7fdcf719', kind: 'background', sessionId, status: 'idle' },
        ]),
      );
    });

    afterEach(() => disableClaudeAgentsList());

    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('pressing its conversation attaches to it, and its card × only detaches', async () => {
      const { manager, spawnArgs, spawned } = workingPtyManager();
      dispatch(
        { type: 'resumeConversation', sessionId, directoryPath: workDir },
        ctx({ runtime, ptyManager: manager }),
      );
      // A second press while the first asks the CLI opens nothing more.
      dispatch(
        { type: 'resumeConversation', sessionId, directoryPath: workDir },
        ctx({ runtime, ptyManager: manager }),
      );
      await flush();

      expect(spawnArgs).toEqual([['attach', '7fdcf719']]);
      const [[id, agent]] = [...store];
      expect(agent.sessionId).toBe(sessionId);

      dispatch({ type: 'closeAgent', id }, ctx({ runtime, ptyManager: manager }));
      expect(spawned[0].killSignals.length).toBeGreaterThan(0);
      expect(store.has(id)).toBe(true);
    });

    it('its conversation row says it runs in the background, once the CLI has answered', async () => {
      const { manager } = workingPtyManager();
      // The sidebar lists the host Directory (the server's cwd).
      const cwdSessions = claudeProvider.getSessionDirs!(process.cwd())[0];
      fs.mkdirSync(cwdSessions, { recursive: true });
      fs.copyFileSync(
        path.join(claudeProvider.getSessionDirs!(workDir)[0], `${sessionId}.jsonl`),
        path.join(cwdSessions, `${sessionId}.jsonl`),
      );
      dispatch({ type: 'requestConversations' }, ctx({ runtime, ptyManager: manager }));
      await flush();

      const rowsOf = (m: Record<string, unknown>) =>
        (
          m as unknown as {
            directories: Array<{
              conversations: Array<{ sessionId: string; liveElsewhere?: unknown }>;
            }>;
          }
        ).directories.flatMap((d) => d.conversations);
      const lists = sent.filter((m) => m.type === 'conversationsLoaded');
      // At once from the cache (nothing asked yet), then again with the answer.
      expect(lists).toHaveLength(2);
      expect(
        rowsOf(lists[0]).find((r) => r.sessionId === sessionId)?.liveElsewhere,
      ).toBeUndefined();
      expect(rowsOf(lists[1]).find((r) => r.sessionId === sessionId)?.liveElsewhere).toEqual({
        status: 'idle',
        kind: 'background',
        backgroundId: '7fdcf719',
      });
    });

    // ── stopAgentSession (the card's skull) ────────────────────

    /** The CLI as the stop sees it: `agents --json` lists the session until
     *  `claude stop` ends it; `refuse` makes the stop fail with that stderr;
     *  `kind` lists it as something other than a background session. */
    function cli(opts: { refuse?: string; kind?: string } = {}) {
      const asked: Array<readonly string[]> = [];
      let stopped = false;
      enableClaudeAgentsList(async (args) => {
        asked.push(args);
        if (args[0] === 'stop') {
          if (opts.refuse) {
            throw Object.assign(new Error('Command failed'), { stderr: `${opts.refuse}\n` });
          }
          stopped = true;
          return '';
        }
        return JSON.stringify(
          stopped
            ? []
            : [{ pid: 25624, id: '7fdcf719', kind: opts.kind ?? 'background', sessionId }],
        );
      });
      return { stops: () => asked.filter((args) => args[0] === 'stop') };
    }

    /** An agent with the office's terminal attached to the session. */
    async function attachedAgent(manager: PtySessionManager): Promise<number> {
      dispatch(
        { type: 'resumeConversation', sessionId, directoryPath: workDir },
        ctx({ runtime, ptyManager: manager }),
      );
      await settle();
      const [[id]] = [...store];
      return id;
    }

    it('stopAgentSession stops the background session, closes its terminal and removes the agent', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { stops } = cli();
      const { manager, spawned } = workingPtyManager();
      const id = await attachedAgent(manager);

      dispatch({ type: 'stopAgentSession', id }, ctx({ runtime, ptyManager: manager }));
      // A second press while the first waits on the CLI stops nothing more.
      dispatch({ type: 'stopAgentSession', id }, ctx({ runtime, ptyManager: manager }));
      await settle();

      expect(stops()).toEqual([['stop', '7fdcf719']]);
      expect(spawned[0].killSignals.length).toBeGreaterThan(0);
      expect(manager.has(id)).toBe(false);
      expect(store.has(id)).toBe(false);
      expect(sent.filter((m) => m.type === 'agentSessionStopFailed')).toEqual([]);
      // The list was asked again: the row no longer reads "Background".
      expect(claudeProvider.liveSessions!().some((s) => s.sessionId === sessionId)).toBe(false);
      log.mockRestore();
    });

    it('stopAgentSession keeps the agent and tells the sender why when claude stop fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { stops } = cli({ refuse: "No job matching '7fdcf719'. Run 'claude agents'" });
      const { manager, spawned } = workingPtyManager();
      const id = await attachedAgent(manager);

      dispatch({ type: 'stopAgentSession', id }, ctx({ runtime, ptyManager: manager }));
      await settle();

      expect(stops()).toHaveLength(1);
      expect(store.has(id)).toBe(true);
      expect(manager.has(id)).toBe(true);
      expect(spawned[0].killSignals).toHaveLength(0);
      expect(sent).toContainEqual({
        type: 'agentSessionStopFailed',
        id,
        reason: "No job matching '7fdcf719'. Run 'claude agents'",
      });
      error.mockRestore();
    });

    it('stopAgentSession never stops a session that runs in another terminal', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { stops } = cli({ kind: 'interactive' });
      store.set(9, { ...makeAgent(9), sessionId, isExternal: true });

      dispatch(
        { type: 'stopAgentSession', id: 9 },
        ctx({ runtime, ptyManager: workingPtyManager().manager }),
      );
      await settle();

      expect(stops()).toEqual([]);
      expect(store.has(9)).toBe(true);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: 'agentSessionStopFailed', id: 9 }),
      );
      warn.mockRestore();
    });

    it('stopAgentSession from an untokened client stops nothing', async () => {
      const { stops } = cli();
      store.set(9, { ...makeAgent(9), sessionId, isExternal: true });

      dispatch(
        { type: 'stopAgentSession', id: 9 },
        ctx({ runtime, ptyManager: workingPtyManager().manager, privileged: false }),
      );
      await settle();

      expect(stops()).toEqual([]);
      expect(store.has(9)).toBe(true);
    });

    it('webviewReady says which agents run in the background', async () => {
      cli();
      await claudeProvider.refreshLiveSessions!();
      store.set(9, { ...makeAgent(9), sessionId, isExternal: true });
      store.set(10, makeAgent(10));

      dispatch({ type: 'webviewReady' }, ctx({ runtime, ptyManager: workingPtyManager().manager }));

      expect(sent).toContainEqual({ type: 'agentBackgroundSessions', agents: { 9: '7fdcf719' } });
    });
  });

  // ── closeAgent ───────────────────────────────────────────────

  it('closeAgent kills the PTY and removes the agent', () => {
    const { manager, spawned } = workingPtyManager();
    store.set(5, makeAgent(5));
    manager.create({ agentId: 5, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch({ type: 'closeAgent', id: 5 }, ctx({ runtime, ptyManager: manager }));

    expect(spawned[0].killSignals.length).toBeGreaterThan(0);
    expect(manager.has(5)).toBe(false);
    expect(store.has(5)).toBe(false);
  });

  it('closeAgent from an untokened client leaves a PTY-backed agent running', () => {
    const { manager, spawned } = workingPtyManager();
    store.set(5, makeAgent(5));
    manager.create({ agentId: 5, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch(
      { type: 'closeAgent', id: 5 },
      ctx({ runtime, ptyManager: manager, privileged: false }),
    );

    expect(spawned[0].killSignals).toHaveLength(0);
    expect(manager.has(5)).toBe(true);
    expect(store.has(5)).toBe(true);
  });

  it("closeAgent takes the Lead's teammates with it", () => {
    const { manager } = workingPtyManager();
    store.set(5, { ...makeAgent(5), isTeamLead: true });
    store.set(6, { ...makeAgent(6), leadAgentId: 5, agentName: 'review-helper' });
    manager.create({ agentId: 5, command: 'claude', args: [], cwd: tempHome, env: {} });

    dispatch({ type: 'closeAgent', id: 5 }, ctx({ runtime, ptyManager: manager }));

    expect(store.has(5)).toBe(false);
    expect(store.has(6)).toBe(false);
  });

  it('closeAgent removes an observed agent that has no PTY', () => {
    store.set(7, makeAgent(7));

    dispatch(
      { type: 'closeAgent', id: 7 },
      ctx({ runtime, ptyManager: workingPtyManager().manager }),
    );

    expect(store.has(7)).toBe(false);
  });
});

/**
 * Tokenless is read-only: an unprivileged client may load the office
 * (webviewReady) and nothing else. One gate at the top of handleClientMessage,
 * so this suite throws EVERY mutating message at it and checks that nothing on
 * disk or in the store moved.
 */
describe('clientMessageHandler: read-only (untokened) clients', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-readonly-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  /** Everything under the temp HOME, as path -> contents. */
  function snapshotHome(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out[full] = fs.readFileSync(full, 'utf-8');
      }
    };
    walk(tempHome);
    return out;
  }

  it('refuses every mutating message and changes nothing', () => {
    const directory = path.join(tempHome, 'project');
    fs.mkdirSync(directory);
    const before = snapshotHome();
    const untokened: ClientMessageContext = {
      store,
      cache: null,
      privileged: false,
      onSetHooksEnabled: () => {
        throw new Error('side effect must not run');
      },
      onReloadAssets: () => {
        throw new Error('side effect must not run');
      },
    };

    for (const msg of [
      { type: 'launchAgent' },
      { type: 'closeAgent', id: 1 },
      { type: 'stopAgentSession', id: 1 },
      { type: 'saveLayout', layout: { version: 1, cols: 1, rows: 1, tiles: [0], furniture: [] } },
      { type: 'saveAgentSeats', seats: { 1: { palette: 1 } } },
      { type: 'setSoundEnabled', enabled: false },
      { type: 'setLastSeenVersion', version: '9.9' },
      { type: 'setAlwaysShowLabels', enabled: true },
      { type: 'setGhostHeadlessAgents', enabled: true },
      { type: 'setWatchAllSessions', enabled: true },
      { type: 'setHooksEnabled', providerId: 'claude', enabled: false },
      { type: 'hooksConsentResponse', providerId: 'claude', choice: 'allow' },
      { type: 'setHooksInfoShown' },
      { type: 'addExternalAssetDirectory', path: directory },
      { type: 'removeExternalAssetDirectory', path: directory },
      { type: 'saveAreaMappings', mappings: { Lab: ['project'] } },
      { type: 'setShowAreas', enabled: true },
      { type: 'setBypassPermissions', enabled: true },
      { type: 'saveCardOrder', order: [2, 1] },
      { type: 'saveDirectory', name: 'Project', path: directory },
      { type: 'removeDirectory', path: directory },
      { type: 'requestDirectorySuggestions' },
      { type: 'requestDiagnostics' },
    ]) {
      handleClientMessage(msg, (m) => sent.push(m), untokened);
    }

    expect(snapshotHome()).toEqual(before);
    // Only truth-restoring replies come back -- no suggestions, no diagnostics.
    const replyTypes = new Set(sent.map((m) => m.type));
    expect([...replyTypes].sort()).toEqual([
      'areaMappingsLoaded',
      'cardOrderLoaded',
      'externalAssetDirectoriesUpdated',
      'settingsLoaded',
    ]);
  });

  it('answers a refused toggle with the real state so the control snaps back', () => {
    handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: false,
    });
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'settingsLoaded', showAreas: false }),
    );

    sent = [];
    handleClientMessage(
      { type: 'saveAreaMappings', mappings: { Lab: ['x'] } },
      (m) => sent.push(m),
      { store, cache: null, privileged: false },
    );
    expect(sent).toEqual([{ type: 'areaMappingsLoaded', mappings: {} }]);
  });

  it('still loads the office', () => {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: false,
    });
    expect(sent.map((m) => m.type)).toEqual(
      expect.arrayContaining(['settingsLoaded', 'existingAgents', 'layoutLoaded']),
    );
  });

  it('tells the client FIRST whether it is read-only, so it never draws the controls', () => {
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: false,
    });
    expect(sent[0]).toEqual({ type: 'officeAccess', readOnly: true });

    sent = [];
    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: true,
    });
    expect(sent[0]).toEqual({ type: 'officeAccess', readOnly: false });
  });
});

/**
 * The agent cards' order is the server's, so the desktop office and the phone
 * show the same cards in the same order.
 */
describe('clientMessageHandler: card order', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-cardorder-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));
    for (const id of [1, 2, 3]) store.set(id, createTestAgent({ id }));
    sent = [];
    broadcasts = [];
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const tokened = (): ClientMessageContext => ({ store, cache: null, privileged: true });

  it('saves a reorder and tells every open office', () => {
    handleClientMessage(
      { type: 'saveCardOrder', order: [3, 1, 2] },
      (m) => sent.push(m),
      tokened(),
    );

    expect(broadcasts).toEqual([{ type: 'cardOrderLoaded', order: [3, 1, 2] }]);
    expect(store.getAdapter()!.loadCardOrder!()).toEqual([3, 1, 2]);
  });

  it('keeps only agents that exist, each once', () => {
    handleClientMessage(
      { type: 'saveCardOrder', order: [3, 99, 3, -1, 1.5, 'x', 1] },
      (m) => sent.push(m),
      tokened(),
    );

    expect(store.getAdapter()!.loadCardOrder!()).toEqual([3, 1]);
  });

  it('ignores a payload that is not an order', () => {
    handleClientMessage({ type: 'saveCardOrder', order: 'nope' }, (m) => sent.push(m), tokened());

    expect(broadcasts).toEqual([]);
    expect(store.getAdapter()!.loadCardOrder!()).toEqual([]);
  });

  it('sends the order on connect, before the agents', () => {
    store.getAdapter()!.saveCardOrder!([2, 1]);

    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), tokened());

    const types = sent.map((m) => m.type);
    expect(sent).toContainEqual({ type: 'cardOrderLoaded', order: [2, 1] });
    expect(types.indexOf('cardOrderLoaded')).toBeLessThan(types.indexOf('existingAgents'));
  });

  it('answers a read-only reorder with the real order', () => {
    store.getAdapter()!.saveCardOrder!([2, 1]);

    handleClientMessage({ type: 'saveCardOrder', order: [1, 2] }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: false,
    });

    expect(sent).toEqual([{ type: 'cardOrderLoaded', order: [2, 1] }]);
    expect(broadcasts).toEqual([]);
    expect(store.getAdapter()!.loadCardOrder!()).toEqual([2, 1]);
  });
});

describe('clientMessageHandler: roster recency', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-recent-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('sends the roster recency on connect', () => {
    const store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    const sent: Array<Record<string, unknown>> = [];

    handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
      store,
      cache: null,
      privileged: true,
    });

    expect(sent).toContainEqual({ type: 'recentCharactersLoaded', recent: [] });
    store.dispose();
  });
});
