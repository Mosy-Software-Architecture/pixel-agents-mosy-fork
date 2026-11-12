/**
 * The office radio in the system's media controls (macOS Now Playing, the
 * media keys, Control Center): the tune on the speakers, whether it plays, and
 * play / pause / next. Browsers list a page there only while one of its media
 * elements plays, which is why the engine plays its mix through an <audio>.
 * DOM-free: the engine hands in `navigator.mediaSession` and `MediaMetadata`.
 */
import { MUSIC_SESSION_ALBUM } from '../constants.js';
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
