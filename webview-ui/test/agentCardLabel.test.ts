import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentCardLabel } from '../src/components/AgentCardLabel.js';
import { SESSION_COLORS } from '../src/constants.js';
import { remoteHostLabel, sessionColor, sessionName } from '../src/office/sessionLabel.js';

const render = (props: Parameters<typeof AgentCardLabel>[0]) =>
  renderToStaticMarkup(createElement(AgentCardLabel, props));

/** The text of the element carrying `data-testid`, from static markup. */
function textOf(html: string, testId: string): string | undefined {
  const match = new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(html);
  return match?.[1];
}

describe('AgentCardLabel', () => {
  it('shows the session name over the activity, two lines', () => {
    const html = render({ name: 'fix login', activity: 'Running: npm test', width: 176 });
    expect(textOf(html, 'agent-card-name')).toBe('fix login');
    expect(textOf(html, 'agent-card-activity')).toBe('Running: npm test');
    expect(html.indexOf('agent-card-name')).toBeLessThan(html.indexOf('agent-card-activity'));
  });

  it('tints the name with its /color', () => {
    const html = render({
      name: 'fix login',
      color: sessionColor('red'),
      activity: 'Idle',
      width: 176,
    });
    expect(html).toContain(`color:${SESSION_COLORS.red}`);
  });

  it('cuts both lines with an ellipsis instead of wrapping, at a fixed width', () => {
    const html = render({ name: 'a very long session name indeed', activity: 'Idle', width: 176 });
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('width:176px');
    const ellipsed = html.match(/text-ellipsis/g) ?? [];
    expect(ellipsed).toHaveLength(2);
  });

  it('says where a remote session runs, beside its name', () => {
    const html = render({
      name: 'deploy',
      host: remoteHostLabel({ host: 'casita', service: true }),
      activity: 'Idle',
      width: 176,
    });
    expect(html).toContain('svc @casita');
  });

  it('names an untitled session after its agent', () => {
    expect(sessionName(3, undefined)).toBe('Agent 3');
    expect(sessionName(3, 'fix login')).toBe('fix login');
  });
});
