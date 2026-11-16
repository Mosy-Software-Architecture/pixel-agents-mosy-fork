import { describe, expect, it } from 'vitest';

import { rowWhere, shortSubpath } from '../src/conversations/subpath.js';

describe("a conversation's subpath", () => {
  it('keeps the first and last folders of a subpath of three or more', () => {
    expect(shortSubpath('finanzas-personales')).toBe('finanzas-personales');
    expect(shortSubpath('repo/sub')).toBe('repo/sub');
    expect(shortSubpath('finanzas-personales/.claude/worktrees/bootstrap')).toBe(
      'finanzas-personales/…/bootstrap',
    );
  });

  it("goes after the Directory's name, shortened to fit, the whole line in its tooltip", () => {
    const sub = 'finanzas-personales/.claude/worktrees/bootstrap';
    // Too long with the name: the subpath's first and last folders alone.
    expect(rowWhere('workspace', sub, true)).toEqual({
      text: 'finanzas-personales/…/bootstrap',
      title: `workspace/${sub}`,
    });
    // Short enough with the name.
    expect(rowWhere('web', 'app/.claude/worktrees/x', true)).toEqual({
      text: 'web/app/.claude/worktrees/x',
    });
    expect(rowWhere('web', 'repo/.claude/worktrees/feature-x', true)).toEqual({
      text: 'web/repo/…/feature-x',
      title: 'web/repo/.claude/worktrees/feature-x',
    });
    // Alone in a Directory's section; the last folder when nothing else fits.
    expect(rowWhere(undefined, sub, true)).toEqual({
      text: 'finanzas-personales/…/bootstrap',
      title: sub,
    });
    expect(
      rowWhere(undefined, 'a-very-long-repository-name-indeed/.claude/worktrees/x', true),
    ).toEqual({
      text: '…/x',
      title: 'a-very-long-repository-name-indeed/.claude/worktrees/x',
    });
    expect(rowWhere(undefined, 'app', true)).toEqual({ text: 'app' });
    expect(rowWhere('workspace', undefined, true)).toEqual({ text: 'workspace' });
    expect(rowWhere(undefined, undefined, true)).toBeUndefined();
  });

  it('shows nothing while Directory names are hidden', () => {
    expect(rowWhere('workspace', 'app', false)).toBeUndefined();
    expect(rowWhere(undefined, 'app', false)).toBeUndefined();
  });
});
