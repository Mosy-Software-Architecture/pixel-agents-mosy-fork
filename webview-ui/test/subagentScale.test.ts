import { describe, expect, it } from 'vitest';

import { characterScale, characterZoom } from '../src/office/subagentScale.js';

describe('sub-agent scale', () => {
  it('draws an agent at the office zoom', () => {
    for (const zoom of [1, 2, 3, 6]) {
      expect(characterZoom(false, zoom)).toBe(zoom);
      expect(characterScale(false, zoom)).toBe(1);
    }
  });

  it('draws a sub-agent one whole zoom step smaller, never under 1', () => {
    expect(characterZoom(true, 4)).toBe(3);
    expect(characterZoom(true, 2)).toBe(1);
    expect(characterZoom(true, 1)).toBe(1);
    expect(Number.isInteger(characterZoom(true, 7))).toBe(true);
  });

  it('scales its world-space size by the same step', () => {
    expect(characterScale(true, 4)).toBe(0.75);
    expect(characterScale(true, 2)).toBe(0.5);
    expect(characterScale(true, 1)).toBe(1);
  });
});
