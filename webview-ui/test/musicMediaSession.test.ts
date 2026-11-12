import { describe, expect, it, vi } from 'vitest';

import { makeSong, type Song } from '../src/music/composer.js';
import { connectMediaSession, quietLoopWav, type TuneInfo } from '../src/music/mediaSession.js';

interface FakeState {
  playing: boolean;
  hidden: boolean;
  song: Song;
  progress: number;
}

/** A radio double: the state the player would publish, and the calls it got. */
function fakeRadio(song: Song) {
  let state: FakeState = { playing: false, hidden: false, song, progress: 0 };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    toggle: vi.fn(async () => {
      state = { ...state, playing: !state.playing };
      emit();
    }),
    skip: vi.fn(),
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set(next: Partial<FakeState>) {
      state = { ...state, ...next };
      emit();
    },
  };
}

/** A stand-in for `navigator.mediaSession`; metadata is the TuneInfo itself. */
function fakeSession() {
  const handlers = new Map<string, () => void>();
  return {
    metadata: null as TuneInfo | null,
    playbackState: 'none' as 'none' | 'paused' | 'playing',
    setActionHandler: vi.fn((action: string, handler: () => void) => {
      handlers.set(action, handler);
    }),
    handlers,
  };
}

const asIs = (info: TuneInfo) => info;
const town = makeSong(1, 'town', null);
const night = makeSong(4, 'night', null);

function connect(song = town) {
  const radio = fakeRadio(song);
  const session = fakeSession();
  connectMediaSession(radio, session, asIs);
  return { radio, session };
}

describe('office radio media session', () => {
  it('does nothing without a media session', () => {
    const makeMetadata = vi.fn(asIs);
    expect(() => connectMediaSession(fakeRadio(town), undefined, makeMetadata)).not.toThrow();
    expect(makeMetadata).not.toHaveBeenCalled();
  });

  it('shows the tune on the speakers and follows each change of tune', () => {
    const { radio, session } = connect();
    expect(session.metadata).toEqual({
      title: town.name,
      artist: expect.stringMatching(/^Town · /),
      album: 'Pixel Agents',
    });

    radio.set({ song: night });
    expect(session.metadata).toEqual({
      title: night.name,
      artist: expect.stringMatching(/^Night · /),
      album: 'Pixel Agents',
    });
  });

  it('keeps the same metadata while the tune does not change', () => {
    const { radio, session } = connect();
    const first = session.metadata;
    radio.set({ progress: 0.5 });
    radio.set({ playing: true });
    expect(session.metadata).toBe(first);
  });

  it('registers play, pause and next track once, and no previous track', () => {
    const { radio, session } = connect();
    radio.set({ song: night });
    radio.set({ playing: true });
    expect(session.setActionHandler).toHaveBeenCalledTimes(3);
    expect([...session.handlers.keys()]).toEqual(['play', 'pause', 'nexttrack']);
  });

  it('play and pause toggle only when they change something; next track skips', () => {
    const { radio, session } = connect();
    const press = (action: string) => session.handlers.get(action)!();

    press('pause');
    expect(radio.toggle).not.toHaveBeenCalled();
    press('play');
    expect(radio.toggle).toHaveBeenCalledTimes(1);
    press('play');
    expect(radio.toggle).toHaveBeenCalledTimes(1);
    press('pause');
    expect(radio.toggle).toHaveBeenCalledTimes(2);

    press('nexttrack');
    expect(radio.skip).toHaveBeenCalledTimes(1);
  });

  it('reports paused, playing, and none with no metadata while the player is hidden', () => {
    const { radio, session } = connect();
    expect(session.playbackState).toBe('paused');

    radio.set({ playing: true });
    expect(session.playbackState).toBe('playing');
    radio.set({ playing: false });
    expect(session.playbackState).toBe('paused');

    radio.set({ hidden: true });
    expect(session.playbackState).toBe('none');
    expect(session.metadata).toBeNull();

    radio.set({ hidden: false });
    expect(session.playbackState).toBe('paused');
    expect(session.metadata).toMatchObject({ title: town.name });
  });

  it('still registers the other actions when the browser rejects one', () => {
    const radio = fakeRadio(town);
    const session = fakeSession();
    session.setActionHandler.mockImplementationOnce(() => {
      throw new TypeError('unsupported');
    });
    connectMediaSession(radio, session, asIs);
    expect([...session.handlers.keys()]).toEqual(['pause', 'nexttrack']);
  });
});

describe('the near-silent loop behind the media session', () => {
  const wav = quietLoopWav();
  const view = new DataView(wav.buffer);
  const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
  const rate = view.getUint32(24, true);
  const dataBytes = view.getUint32(40, true);
  const samples = Array.from({ length: dataBytes / 2 }, (_, i) => view.getInt16(44 + i * 2, true));

  it('is a mono 16-bit PCM WAV whose sizes add up', () => {
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(text(12, 4)).toBe('fmt ');
    expect(text(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(dataBytes).toBe(wav.length - 44);
  });

  it('lasts longer than the 5 s Chrome needs to treat it as content', () => {
    expect(samples.length / rate).toBeGreaterThan(5);
  });

  it('is quiet, around -50 dBFS, but not digital silence', () => {
    const rms = Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length) / 32768;
    const dbfs = 20 * Math.log10(rms);
    expect(dbfs).toBeGreaterThan(-52);
    expect(dbfs).toBeLessThan(-48);
  });
});
