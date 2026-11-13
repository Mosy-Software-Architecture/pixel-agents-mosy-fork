import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { preToolUseBash } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  enableMockBackgroundSessions,
  mockBackgroundSessions,
  stopMockBackgroundSessions,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { agentCard, expectOverlayCount, expectOverlayVisible } from '../../helpers/office';
import { getLaunchDrawer, setSettings } from '../../helpers/webview';

/**
 * + Agent starts its session in Claude Code's background service (`claude
 * --bg`) and the office's terminal attaches to it (`claude attach <id>`), so
 * the agent outlives its terminal and the server. The mock plays that service:
 * `--bg` starts a detached worker that runs the scenario as the session,
 * `agents --json` lists it, `attach` follows it (e2e/fixtures/mock-claude-runner.cjs).
 * Terminal-driven: the mock performs every timed action; the test clicks and
 * observes (e2e/README.md "Mocking model & rules").
 */

/** + Agent into the workspace's Directory. */
async function launchFromDrawer(page: Page, workspaceDir: string): Promise<void> {
  await page.getByRole('button', { name: 'New agent' }).click();
  await getLaunchDrawer(page)
    .getByRole('button', { name: path.basename(workspaceDir), exact: true })
    .click();
}

/** The background scenario: a title (so the sidebar lists it), then a Bash
 *  tool start whose hook names the session `--bg` gave it. */
function backgroundScenario(name: string) {
  return claudeScenario(name)
    .at(300)
    .appendJsonl({ type: 'ai-title', aiTitle: 'Work in the background' })
    .at(1_000)
    .emitHook(preToolUseBash('{{sessionId}}', 'npm test') as Record<string, unknown>)
    .holdOpenFor(90_000)
    .build();
}

test.describe('Standalone / background sessions', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test.afterEach(({ standalone }) => stopMockBackgroundSessions(standalone.tmpHome));

  test('+ Agent runs in the background: its terminal attaches, closing it only detaches, and the row attaches again @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    enableMockBackgroundSessions(standalone.tmpHome);
    await arrangeNextClaudeInvocation(standalone.tmpHome, backgroundScenario('background launch'));

    await launchFromDrawer(page, standalone.workspaceDir);

    // The terminal is a client of the background session.
    const card = agentCard(page, 1);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const terminal = page.locator('.xterm').first();
    await expect(terminal).toContainText('mock claude attached to background session', {
      timeout: 15_000,
    });
    await expect.poll(() => mockBackgroundSessions(standalone.tmpHome)).toHaveLength(1);
    // The session's own hooks reach this agent: it is bound to the id --bg gave.
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    const row = page
      .getByTestId('conversation-sidebar')
      .getByTestId('conversation-row')
      .filter({ hasText: 'Work in the background' });
    await expect(row.getByTestId('conversation-live-elsewhere')).toHaveText('Background · idle', {
      timeout: 15_000,
    });

    // The card's × closes the office's terminal only: the session runs on and
    // the agent stays, Headless, with the same character.
    await card.locator('button[title="Close agent"]').click();
    await expect(page.locator('.xterm')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 1);
    await expect(card).toHaveCount(1);
    expect(mockBackgroundSessions(standalone.tmpHome)).toHaveLength(1);

    // Its row attaches again, into the same agent: no second character.
    await row.click();
    await expect(page.locator('.xterm').first()).toContainText(
      'mock claude attached to background session',
      { timeout: 15_000 },
    );
    await expectOverlayCount(page, 1);
    await expect(page.locator('[data-testid="agent-card"]')).toHaveCount(1);
  });

  test('an agent launched into the background outlives the server and comes back Headless @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    enableMockBackgroundSessions(standalone.tmpHome);
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      backgroundScenario('outlives the server'),
    );

    await launchFromDrawer(page, standalone.workspaceDir);
    await expect(page.locator('.xterm').first()).toContainText(
      'mock claude attached to background session',
      { timeout: 15_000 },
    );
    await expectOverlayCount(page, 1);
    const before = await page.evaluate(() => {
      const hooks = window.__pixelAgentsTestHooks!;
      const ch = hooks.getCharacters!().find((c) => !c.isGreeter)!;
      return { id: ch.id, palette: ch.palette, repeat: ch.repeat };
    });
    const [session] = mockBackgroundSessions(standalone.tmpHome);

    await standalone.stopHost();
    // The server is gone; the session is not.
    expect(mockBackgroundSessions(standalone.tmpHome).map((s) => s.sessionId)).toEqual([
      session.sessionId,
    ]);

    await standalone.startHost();
    // Back in the office, Headless (no terminal), same id and look.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const hooks = window.__pixelAgentsTestHooks!;
            const chars = hooks.getCharacters!().filter((c) => !c.isGreeter);
            return chars.map((c) => ({ id: c.id, palette: c.palette, repeat: c.repeat }));
          }),
        { timeout: 20_000 },
      )
      .toEqual([before]);
    await expect(page.locator('.xterm')).toHaveCount(0);
    await expect(
      page
        .getByTestId('conversation-sidebar')
        .getByTestId('conversation-row')
        .filter({ hasText: 'Work in the background' })
        .getByTestId('conversation-live-elsewhere'),
    ).toHaveText('Background · idle', { timeout: 15_000 });
  });
});
