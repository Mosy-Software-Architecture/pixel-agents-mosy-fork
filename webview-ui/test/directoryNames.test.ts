import { afterEach, describe, expect, it } from 'vitest';

import {
  setShowDirectoryNames,
  showDirectoryNames,
  shownDirectoryName,
  subscribeShowDirectoryNames,
} from '../src/office/directoryNames.js';

describe('Show Directory Names', () => {
  afterEach(() => setShowDirectoryNames(true));

  it('is on until the settings say otherwise, and tells its readers when it changes', () => {
    expect(showDirectoryNames()).toBe(true);
    let calls = 0;
    const unsubscribe = subscribeShowDirectoryNames(() => calls++);
    setShowDirectoryNames(false);
    setShowDirectoryNames(false);
    expect(showDirectoryNames()).toBe(false);
    expect(calls).toBe(1);
    unsubscribe();
    setShowDirectoryNames(true);
    expect(calls).toBe(1);
  });

  it("drops a row's or label's Directory line while names are hidden", () => {
    expect(shownDirectoryName('workspace', true)).toBe('workspace');
    expect(shownDirectoryName('workspace', false)).toBeUndefined();
    expect(shownDirectoryName('', true)).toBeUndefined();
    expect(shownDirectoryName(undefined, true)).toBeUndefined();
  });
});
