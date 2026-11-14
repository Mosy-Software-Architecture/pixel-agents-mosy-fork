import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup, stop } from '../../helpers/hooks';
import { expectOverlayCount } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

/**
 * Done marks: ~/.claude/session-marks.json (shared with feature-flow and the
 * `agent` CLI). A conversation whose session is marked done leaves the
 * sidebar's lists and shows only under "See all", with a green check in front
 * of its title; a row's check button there marks or unmarks it (the office
 * writes the file, `by: office`). A live agent whose session is marked shows
 * the check on its card, and the card's check button takes it off.
 *
 * The transcripts and the marks file are seeded on disk, as the CLI and the
 * toolkit would leave them; the test only clicks and observes.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

/** A finished conversation: a prompt, then its title, written an hour ago. */
function seedConversation(projectDir: string, n: number, title: string): string {
  const file = path.join(projectDir, `${uuid(n)}.jsonl`);
  const hourAgo = Date.now() - 3_600_000 + n * 60_000;
  fs.writeFileSync(
    file,
    [
      {
        type: 'user',
        sessionId: uuid(n),
        message: { role: 'user', content: `please do ${title}` },
        timestamp: new Date(hourAgo).toISOString(),
      },
      { type: 'ai-title', aiTitle: title, sessionId: uuid(n) },
    ]
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  fs.utimesSync(file, hourAgo / 1000, hourAgo / 1000);
  return file;
}

function marksFile(home: string): string {
  return path.join(home, '.claude', 'session-marks.json');
}

function writeMarks(home: string, sessionIds: string[]): void {
  const done = new Date().toISOString();
  fs.writeFileSync(
    marksFile(home),
    JSON.stringify({
      version: 1,
      marks: Object.fromEntries(sessionIds.map((id) => [id, { done, by: 'feature-flow' }])),
    }),
  );
}

function readMarks(home: string): Record<string, { done: string; by: string }> {
  try {
    return JSON.parse(fs.readFileSync(marksFile(home), 'utf8')).marks ?? {};
  } catch {
    return {};
  }
}

test.describe('Standalone / done marks', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a done conversation shows only under See all, with a check, and its check button marks and unmarks @area:standalone', async ({
    page,
    standalone,
  }) => {
    const projectDir = projectDirOf(standalone.tmpHome, standalone.workspaceDir);
    seedConversation(projectDir, 1, 'Write the parser');
    seedConversation(projectDir, 2, 'Ship the release');
    seedConversation(projectDir, 3, 'Fix the build');
    writeMarks(standalone.tmpHome, [uuid(2)]);
    await page.reload();

    const sidebar = page.getByTestId('conversation-sidebar');
    const recent = sidebar.getByTestId('recent-conversations').getByTestId('conversation-row');
    await expect(recent).toHaveCount(2);
    await expect(recent.filter({ hasText: 'Ship the release' })).toHaveCount(0);

    // See all: every conversation, the done one with its check.
    await sidebar.getByTestId('conversations-see-all').click();
    const search = page.getByTestId('conversation-search');
    const results = search.getByTestId('conversation-row');
    await expect(results).toHaveCount(3);
    const shipped = results.filter({ hasText: 'Ship the release' });
    await expect(shipped.getByTestId('conversation-done')).toBeVisible();
    await expect(
      results.filter({ hasText: 'Fix the build' }).getByTestId('conversation-done'),
    ).toHaveCount(0);

    // Mark another from its row: the office writes the file, the row gets its check.
    const fixRow = search
      .locator('div.group\\/row')
      .filter({ has: page.getByTestId('conversation-row').filter({ hasText: 'Fix the build' }) });
    await fixRow.hover();
    await fixRow.getByTestId('conversation-mark-done').click();
    await expect.poll(() => readMarks(standalone.tmpHome)[uuid(3)]?.by).toBe('office');
    await expect(
      results.filter({ hasText: 'Fix the build' }).getByTestId('conversation-done'),
    ).toBeVisible();

    // Unmark the first: its mark leaves the file and its check the row.
    const shipRow = search.locator('div.group\\/row').filter({
      has: page.getByTestId('conversation-row').filter({ hasText: 'Ship the release' }),
    });
    await shipRow.getByTestId('conversation-mark-done').click();
    await expect.poll(() => uuid(2) in readMarks(standalone.tmpHome)).toBe(false);
    await expect(shipped.getByTestId('conversation-done')).toHaveCount(0);

    // Back in the sidebar the lists follow: the unmarked one is back, the marked one gone.
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    await expect(recent.filter({ hasText: 'Ship the release' })).toHaveCount(1);
    await expect(recent.filter({ hasText: 'Fix the build' })).toHaveCount(0);
  });

  test("a live agent whose session is marked done shows the check on its card, and the card's check takes it off @area:standalone", async ({
    page,
    standalone,
  }) => {
    await setSettings(page, { alwaysShowLabels: true, watchAllSessions: true });
    const projectDir = projectDirOf(standalone.tmpHome, standalone.workspaceDir);
    const transcriptPath = seedConversation(projectDir, 7, 'Review the docs');
    writeMarks(standalone.tmpHome, [uuid(7)]);

    // Adopted through its hooks: an agent in the office running that session.
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(uuid(7), standalone.workspaceDir, transcriptPath),
    );
    await sendHookEvent(standalone.hookServerConfig, stop(uuid(7)));
    await expectOverlayCount(page, 1);

    const card = page.getByTestId('agent-card').first();
    await expect(card.getByTestId('agent-card-done')).toBeVisible();
    await card.hover();
    const check = card.getByTestId('card-mark-done');
    await expect(check).toHaveAttribute('aria-pressed', 'true');
    await check.click();
    await expect.poll(() => uuid(7) in readMarks(standalone.tmpHome)).toBe(false);
    await expect(card.getByTestId('agent-card-done')).toHaveCount(0);

    // And on again from the card.
    await card.hover();
    await check.click();
    await expect.poll(() => readMarks(standalone.tmpHome)[uuid(7)]?.by).toBe('office');
    await expect(card.getByTestId('agent-card-done')).toBeVisible();
  });
});
