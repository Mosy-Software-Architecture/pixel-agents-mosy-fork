/**
 * The office radio in the system's media controls (macOS Now Playing, the
 * media keys, Control Center): the tune on the speakers, whether it plays, and
 * play / pause / next. Chrome lists a page there only while one of its media
 * elements plays content, so the engine loops `silentLoopWav` in an <audio>
 * beside the mix. DOM-free: the engine hands in `navigator.mediaSession` and
 * `MediaMetadata`.
 */
import {
  MUSIC_SESSION_ALBUM,
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
 * A mono 16-bit WAV of digital silence (all-zero samples). Chrome hands the
 * system's controls only a media element playing content: a file over 5 s long
 * (shorter is a "transient" sound), never a MediaStream (`srcObject` plays as a
 * call, a "one-shot" player). Silence is enough: it doesn't have to be heard.
 */
export function silentLoopWav(
  seconds = MUSIC_SESSION_LOOP_SEC,
  rate = MUSIC_SESSION_LOOP_RATE,
): Uint8Array<ArrayBuffer> {
  const dataBytes = Math.round(seconds * rate) * 2;
  const bytes = new Uint8Array(44 + dataBytes); // the samples stay zero
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
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
  view.setUint32(40, dataBytes, true);
  return bytes;
}
