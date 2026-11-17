import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup, stop } from '../../helpers/hooks';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../helpers/mock-claude';
import { expectOverlayCount } from '../../helpers/office';
import { getLaunchDrawer, setSettings } from '../../helpers/webview';

/**
 * A `/clear` leaves its old transcript behind (MOS-947). Claude Code 2.1.325
 * fires no hook for it, so the office sees it in the CLI's registry (the same
 * process names another session) or, when it was not running, infers it from
 * the transcripts. Either way the session keeps ONE character, the old
 * transcript leaves Recent and By Directory, the search labels it "cleared →
 * continues in <id>", and pressing it goes to the agent instead of resuming a
 * session that is over.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function invocations(logFile: string): string {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

function projectDirOf(home: string, workspaceDir: string): string {
  const dir = path.join(
    home,
    '.claude',
    'projects',
    fs.realpathSync(workspaceDir).replace(/[^a-zA-Z0-9-]/g, '-'),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The camera follows the agent a sidebar press went to. */
async function followed(page: Page): Promise<number | null> {
  return page.evaluate(() => window.__pixelAgentsTestHooks!.getCameraFollowId!());
}

test.describe('Standalone / a /clear supersedes the old transcript', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a /clear while the office runs keeps one character; the old row leaves Recent, is labelled in See all and goes to the agent @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    await waitForClaudeHookSetup(standalone.tmpHome);
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('cleared while the office runs')
        .registerSession({ name: 'lead' })
        .at(100)
        .appendJsonl({ type: 'custom-title', customTitle: 'lead', sessionId: '{{sessionId}}' })
        .at(400)
        .emitHook(stop('{{sessionId}}') as Record<string, unknown>)
        .at(3_000)
        .clear()
        // The new session's first turn: before the fix it came in as a
        // second character.
        .at(6_000)
        .appendJsonl({ type: 'assistant', message: { role: 'assistant', content: [] } })
        .at(6_100)
        .emitHook(stop('{{sessionId}}') as Record<string, unknown>)
        .holdOpenFor(60_000)
        .build(),
    );
    await page.getByRole('button', { name: 'New agent' }).click();
    await getLaunchDrawer(page)
      .getByRole('button', { name: path.basename(standalone.workspaceDir), exact: true })
      .click();

    await expectOverlayCount(page, 1);
    const card = page.getByTestId('agent-card');
    await expect(card).toHaveCount(1);
    const agentId = Number(await card.getAttribute('data-agent-id'));

    // The process went on as another session: the same character runs it.
    // The mock clears at 3 s and the new session ends a turn at 6 s.
    await page.waitForTimeout(8_000);
    await expectOverlayCount(page, 1);
    await expect(card).toHaveCount(1);

    // Recent lists the session once: the transcript it left is not a row.
    const sidebar = page.getByTestId('conversation-sidebar');
    const recent = sidebar.getByTestId('recent-conversations').getByTestId('conversation-row');
    await expect(recent.filter({ hasText: 'lead' })).toHaveCount(1, { timeout: 15_000 });
    await expect(recent.locator('[data-superseded]')).toHaveCount(0);

    // See all: both, the old one labelled with where it continues.
    await sidebar.getByTestId('conversations-see-all').click();
    const search = page.getByTestId('conversation-search');
    const old = search.getByTestId('conversation-row').filter({
      has: page.getByTestId('conversation-superseded'),
    });
    await expect(old).toHaveCount(1);
    await expect(old.getByTestId('conversation-superseded')).toHaveText(
      /cleared → continues in [0-9a-f]{8}/,
    );

    // Pressing it goes to the agent; nothing is resumed.
    await page.evaluate(() => window.__pixelAgentsTestHooks!.selectAgent!(null));
    await old.click();
    await expect.poll(() => followed(page)).toBe(agentId);
    await page.waitForTimeout(1_000);
    expect(invocations(standalone.mockLogFile)).not.toContain('--resume');
    await expect(card).toHaveCount(1);
  });

  test('a /clear while the office was not running is inferred: the same outcome @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const projectDir = projectDirOf(standalone.tmpHome, standalone.workspaceDir);
    const cwd = fs.realpathSync(standalone.workspaceDir);
    const t0 = Date.now() - 30 * 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    // The session before the /clear: its last record, then nothing more.
    const oldFile = path.join(projectDir, `${uuid(1)}.jsonl`);
    fs.writeFileSync(
      oldFile,
      [
        { type: 'custom-title', customTitle: 'lead', sessionId: uuid(1) },
        { type: 'user', message: { role: 'user', content: 'go' }, timestamp: iso(t0), cwd },
        { type: 'assistant', timestamp: iso(t0 + 60_000), cwd },
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
    fs.utimesSync(oldFile, (t0 + 70_000) / 1000, (t0 + 70_000) / 1000);
    // The one the /clear started, in the same process (which still runs).
    const newFile = path.join(projectDir, `${uuid(2)}.jsonl`);
    fs.writeFileSync(
      newFile,
      [
        { type: 'custom-title', customTitle: 'lead', sessionId: uuid(2) },
        {
          type: 'user',
          message: { role: 'user', content: '<command-name>/clear</command-name>' },
          timestamp: iso(t0 + 70_000),
          cwd,
        },
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
    const registry = path.join(standalone.tmpHome, '.claude', 'sessions');
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(
      path.join(registry, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: uuid(2), name: 'lead', cwd, status: 'idle' }),
    );

    // Its agent, adopted through the new session's hooks.
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(uuid(2), standalone.workspaceDir, newFile),
    );
    await sendHookEvent(standalone.hookServerConfig, stop(uuid(2)));
    await expectOverlayCount(page, 1);
    const agentId = Number(await page.getByTestId('agent-card').getAttribute('data-agent-id'));

    const sidebar = page.getByTestId('conversation-sidebar');
    const recent = sidebar.getByTestId('recent-conversations').getByTestId('conversation-row');
    await expect(recent.filter({ hasText: 'lead' })).toHaveCount(1, { timeout: 15_000 });

    await sidebar.getByTestId('conversations-see-all').click();
    const search = page.getByTestId('conversation-search');
    const old = search.getByTestId('conversation-row').filter({
      has: page.getByTestId('conversation-superseded'),
    });
    await expect(old.getByTestId('conversation-superseded')).toHaveText(
      `cleared → continues in ${uuid(2).slice(0, 8)}`,
    );
    await old.click();
    await expect.poll(() => followed(page)).toBe(agentId);
    expect(invocations(standalone.mockLogFile)).not.toContain('--resume');
    await expectOverlayCount(page, 1);
  });

  test('pressing a past conversation whose title runs under another id spawns nothing and says where it runs @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    const projectDir = projectDirOf(standalone.tmpHome, standalone.workspaceDir);
    const cwd = fs.realpathSync(standalone.workspaceDir);
    const past = path.join(projectDir, `${uuid(1)}.jsonl`);
    fs.writeFileSync(
      past,
      [
        { type: 'custom-title', customTitle: 'lead', sessionId: uuid(1) },
        { type: 'user', message: { role: 'user', content: 'go' }, cwd },
      ]
        .map((r) => JSON.stringify(r) + '\n')
        .join(''),
    );
    // Written an hour ago: a past conversation, not one the scanners adopt.
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    fs.utimesSync(past, hourAgo, hourAgo);
    // Another terminal runs "lead" under another id (this test's own process
    // stands in for it).
    const registry = path.join(standalone.tmpHome, '.claude', 'sessions');
    fs.mkdirSync(registry, { recursive: true });
    fs.writeFileSync(
      path.join(registry, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: uuid(9), name: 'lead', cwd, status: 'busy' }),
    );
    await page.reload();

    const row = page
      .getByTestId('conversation-sidebar')
      .getByTestId('conversation-row')
      .filter({ hasText: 'lead' });
    await row.click();
    await expect(page.getByTestId('office-notice')).toHaveText(
      'Already running as "lead" in another terminal',
    );
    await page.waitForTimeout(1_000);
    expect(invocations(standalone.mockLogFile)).not.toContain('--resume');
    await expect(page.locator('.xterm')).toHaveCount(0);
    await expectOverlayCount(page, 0);
  });
});
