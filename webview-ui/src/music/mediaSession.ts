/**
 * The office radio in the system's media controls (macOS Now Playing, the
 * media keys, Control Center): the tune on the speakers, whether it plays, and
 * play / pause / next. Chrome lists a page there only while one of its media
 * elements plays content, so the engine loops `quietLoopWav` in an <audio>
 * beside the mix. DOM-free: the engine hands in `navigator.mediaSession` and
 * `MediaMetadata`.
 */
import {
  MUSIC_SESSION_ALBUM,
  MUSIC_SESSION_LOOP_DBFS,
  MUSIC_SESSION_LOOP_RATE,
  MUSIC_SESSION_LOOP_SEC,
} from '../constants.js';
import type { Song } from './composer.js';
import { MOODS } from './moods.js';
import { keyLabel } from './songCode.js';

interface Radio {
  subscribe(fn: () => void): () => void;
  getState(): { playing: boolean; hidden: boolean; song: Song };
  toggle(): Promise<void>;
  skip(): void;
}

/** The part of the browser's media session this uses (`navigator.mediaSession`). */
interface MediaSessionLike<M> {
  metadata: M | null;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: 'play' | 'pause' | 'nexttrack', handler: () => void): void;
}

/** What the system's controls show for a tune. */
export interface TuneInfo {
  title: string;
  artist: string;
  album: string;
}

/** Keeps `session` in step with the radio; does nothing without one. */
export function connectMediaSession<M>(
  radio: Radio,
  session: MediaSessionLike<M> | undefined,
  makeMetadata: (info: TuneInfo) => M,
): void {
  if (!session) return;
  const handlers: Array<[Parameters<MediaSessionLike<M>['setActionHandler']>[0], () => void]> = [
    [
      'play',
      () => {
        if (!radio.getState().playing) void radio.toggle();
      },
    ],
    [
      'pause',
      () => {
        if (radio.getState().playing) void radio.toggle();
      },
    ],
    ['nexttrack', () => radio.skip()],
  ];
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // A browser that doesn't know the action: the others still work.
    }
  }

  let shown: Song | null = null;
  const sync = () => {
    const state = radio.getState();
    // A hidden player has no music to control: leave the system's controls.
    if (state.hidden) {
      shown = null;
      session.metadata = null;
      session.playbackState = 'none';
      return;
    }
    if (state.song !== shown) {
      shown = state.song;
      session.metadata = makeMetadata({
        title: shown.name,
        artist: `${MOODS[shown.moodKey].label} · ${keyLabel(shown)}`,
        album: MUSIC_SESSION_ALBUM,
      });
    }
    session.playbackState = state.playing ? 'playing' : 'paused';
  };
  radio.subscribe(sync);
  sync();
}

/**
 * A mono 16-bit WAV of low-level noise (RMS `dbfs`). Chrome hands the system's
 * controls only a media element playing content: a file over 5 s long (shorter
 * is a "transient" sound), never a MediaStream (`srcObject` plays as a call, a
 * "one-shot" player). Noise rather than zeros, so it is a real sound.
 */
export function quietLoopWav(
  seconds = MUSIC_SESSION_LOOP_SEC,
  rate = MUSIC_SESSION_LOOP_RATE,
  dbfs = MUSIC_SESSION_LOOP_DBFS,
): Uint8Array<ArrayBuffer> {
  const samples = Math.round(seconds * rate);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  // Uniform noise in ±a has an RMS of a/√3.
  const a = Math.sqrt(3) * 32767 * 10 ** (dbfs / 20);
  for (let i = 0; i < samples; i++)
    view.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * a), true);
  return bytes;
}
