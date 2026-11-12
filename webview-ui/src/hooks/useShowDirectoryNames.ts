import { useSyncExternalStore } from 'react';

import { showDirectoryNames, subscribeShowDirectoryNames } from '../office/directoryNames.js';

/** Settings → Show Directory Names, kept current (office/directoryNames.ts). */
export function useShowDirectoryNames(): boolean {
  return useSyncExternalStore(subscribeShowDirectoryNames, showDirectoryNames);
}
