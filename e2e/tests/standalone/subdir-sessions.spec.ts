import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '../../fixtures/standalone';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../helpers/mock-claude';
import { agentCard } from '../../helpers/office';
import { setSettings } from '../../helpers/webview';

/**
 * A session that started in a Directory and moved into a folder below it (a
 * worktree, a subrepo) has its transcript filed under that folder's key, not
 * the Directory's. The sidebar still lists it under the Directory, with where
 * it runs under its title, and resuming it runs `claude --resume` there, where
 * the CLI looks for it.
 *
 * The transcript is seeded on disk, as the CLI would leave it; the test only
 * clicks and observes.
 */

const SESSION_ID = '00000000-0000-4000-8000-0000000000c1';
const SUBPATH = 'finanzas-personales/.claude/worktrees/bootstrap';

const keyOf = (dir: string) => dir.replace(/[^a-zA-Z0-9-]/g, '-');

/** The mock's invocation log, empty until its first launch writes it. */
function invocations(logFile: string): string {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

/** A finished session that started in `startedIn` and now runs in `runsIn`,
 *  filed under `runsIn`'s key, written an hour ago. */
function seedMovedSession(home: string, startedIn: string, runsIn: string, title: string): void {
  const projectDir = path.join(home, '.claude', 'projects', keyOf(runsIn));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const hourAgo = Date.now() - 3_600_000;
  const user = (cwd: string, content: string) => ({
    type: 'user',
    cwd,
    sessionId: SESSION_ID,
    message: { role: 'user', content },
    timestamp: new Date(hourAgo).toISOString(),
  });
  fs.writeFileSync(
    file,
    [
      user(startedIn, 'set up the worktree'),
      user(runsIn, 'now bootstrap it'),
      { type: 'ai-title', aiTitle: title, sessionId: SESSION_ID },
    ]
      .map((r) => JSON.stringify(r) + '\n')
      .join(''),
  );
  fs.utimesSync(file, hourAgo / 1000, hourAgo / 1000);
}

test.describe('Standalone / sessions below a Directory', () => {
  test.skip(process.platform === 'win32', 'PTY spawn of the .cmd mock shim is untested on Windows');
  test.use({ standaloneOptions: { mockClaude: true } });

  test('a session that moved into a worktree is listed under its Directory with where it runs, and resumes there @area:standalone', async ({
    page,
    standalone,
  }) => {
    const workspace = fs.realpathSync(standalone.workspaceDir);
    const worktree = path.join(workspace, ...SUBPATH.split('/'));
    fs.mkdirSync(worktree, { recursive: true });
    seedMovedSession(standalone.tmpHome, workspace, worktree, 'Bootstrap the ledger');
    await page.reload();

    const directoryName = path.basename(standalone.workspaceDir);
    const sidebar = page.getByTestId('conversation-sidebar');
    const row = sidebar
      .getByTestId('recent-conversations')
      .getByTestId('conversation-row')
      .filter({ hasText: 'Bootstrap the ledger' });
    await expect(row).toBeVisible();
    // Under its title: where it runs, its first and last folders (the
    // Directory's name before it would not fit), the whole of it in the tooltip.
    const where = row.getByTestId('conversation-where');
    await expect(where).toHaveText('finanzas-personales/…/bootstrap');
    await expect(where).toHaveAttribute('title', `${directoryName}/${SUBPATH}`);

    // See all finds it too, with the same line.
    await sidebar.getByTestId('conversations-see-all').click();
    const search = page.getByTestId('conversation-search');
    await expect(
      search
        .getByTestId('conversation-row')
        .filter({ hasText: 'Bootstrap the ledger' })
        .getByTestId('conversation-where'),
    ).toHaveAttribute('title', `${directoryName}/${SUBPATH}`);
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0);

    // Show Directory Names off: nothing under the title.
    await setSettings(page, { showDirectoryNames: false });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('conversation-where')).toHaveCount(0);
    await setSettings(page, { showDirectoryNames: true });
    await expect(where).toBeVisible();

    // Resuming it runs claude --resume in the worktree, where the CLI files it.
    await arrangeNextClaudeInvocation(
      standalone.tmpHome,
      claudeScenario('resumed in its worktree').holdOpenFor(60_000).build(),
    );
    await row.click();
    await expect(agentCard(page, 1)).toBeVisible();
    await expect
      .poll(() => invocations(standalone.mockLogFile))
      .toContain(`cwd=${worktree} args=--resume ${SESSION_ID}`);
  });
});
