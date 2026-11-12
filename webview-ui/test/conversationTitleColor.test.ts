import { describe, expect, it } from 'vitest';

import { SESSION_COLORS } from '../src/constants.js';
import { conversationTitleColor } from '../src/conversations/titleColor.js';

describe("a conversation row's title colour (the session's /color)", () => {
  it('is the shade the label over the character uses', () => {
    expect(conversationTitleColor({ color: 'red' })).toBe(SESSION_COLORS.red);
    expect(conversationTitleColor({ color: 'Purple' })).toBe(SESSION_COLORS.purple);
  });

  it('leaves a title without a colour, or with one the office does not know, as it was', () => {
    expect(conversationTitleColor({})).toBeUndefined();
    expect(conversationTitleColor({ color: 'teal' })).toBeUndefined();
  });
});
