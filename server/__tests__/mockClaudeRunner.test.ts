import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MOCK_CLAUDE_RUNNER = path.join(__dirname, '../../e2e/fixtures/mock-claude-runner.cjs');

let tmpBase: string;
let tmpHome: string;
let workspaceDir: string;

function makeNodeCommand(scriptPath: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`;
}

function writeHookScript(scriptPath: string, outputPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      'let input = "";',
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      `process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(outputPath)}, input));`,
    ].join('\n'),
  );
}

function writeScenarioQueue(homeDir: string, queue: unknown[]): void {
  const queuePath = path.join(homeDir, '.claude-mock', 'scenario-queue.json');
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function writeSettings(
  homeDir: string,
  hooks: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
  >,
): void {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
}

function runMockClaude(
  sessionId = 'test-session',
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MOCK_CLAUDE_RUNNER, '--session-id', sessionId], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        HOME: tmpHome,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('mock-claude-runner hook execution', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-mock-runner-'));
    tmpHome = path.join(tmpBase, 'home');
    workspaceDir = path.join(tmpBase, 'workspace');

    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // macOS /var → /private/var symlink: the runner sees the resolved cwd via
    // process.cwd(), so its project hash and our expected paths must use the
    // same realpath. Without this, fs.existsSync below sometimes returns false
    // on the symlinked path even though the file exists on the resolved path.
    tmpHome = fs.realpathSync.native(tmpHome);
    workspaceDir = fs.realpathSync.native(workspaceDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('executes only Pixel Agents hooks from ~/.claude/settings.json', async () => {
    const pixelOutput = path.join(tmpBase, 'pixel-hook.json');
    const thirdPartyOutput = path.join(tmpBase, 'third-party-hook.json');
    const pixelHookPath = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
    const thirdPartyHookPath = path.join(tmpHome, '.claude', 'third-party-hook.js');

    writeHookScript(pixelHookPath, pixelOutput);
    writeHookScript(thirdPartyHookPath, thirdPartyOutput);
    writeSettings(tmpHome, {
      Notification: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: makeNodeCommand(thirdPartyHookPath),
            },
            {
              type: 'command',
              command: makeNodeCommand(pixelHookPath),
            },
          ],
        },
      ],
    });
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'emitHook',
            atMs: 0,
            payload: {
              session_id: 'test-session',
              hook_event_name: 'Notification',
              notification_type: 'idle_prompt',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude();

    expect(code, stderr).toBe(0);
    expect(fs.existsSync(pixelOutput)).toBe(true);
    expect(fs.existsSync(thirdPartyOutput)).toBe(false);
    expect(JSON.parse(fs.readFileSync(pixelOutput, 'utf8'))).toMatchObject({
      session_id: 'test-session',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
  });

  it('writes configured sidecar metadata next to custom transcript paths', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [
          {
            alias: 'teammate',
            sessionIdTemplate: 'agent-web-researcher',
            transcriptPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.jsonl',
            sidecarPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.meta.json',
            sidecarJson: {
              agentType: 'web-researcher',
            },
          },
        ],
        actions: [
          {
            kind: 'appendJsonl',
            atMs: 0,
            session: 'teammate',
            record: {
              type: 'system',
              teamName: 'research',
              agentName: 'web-researcher',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);

    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'lead-session',
      'subagents',
      'agent-web-researcher.jsonl',
    );
    const sidecarPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');

    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))).toEqual({
      agentType: 'web-researcher',
    });
  });

  it('writes timed JSON files with template paths', async () => {
    const configPath = path.join(tmpHome, '.claude', 'teams', 'research', 'config.json');

    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'writeJson',
            atMs: 0,
            filePath: configPath,
            value: {
              members: [{ name: 'lead' }],
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      members: [{ name: 'lead' }],
    });
  });

  it('deletes configured paths with template values', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: true,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'deletePath',
            atMs: 0,
            filePath: '{{transcriptPath}}',
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('delete-session');

    expect(code, stderr).toBe(0);
    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'delete-session.jsonl',
    );
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });

  /** Run the mock with `args`, wait for it, and keep its stdout. */
  function runMock(args: string[]): Promise<{ code: number | null; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [MOCK_CLAUDE_RUNNER, ...args], {
        cwd: workspaceDir,
        env: { ...process.env, HOME: tmpHome },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.on('close', (code) => resolve({ code, stdout }));
    });
  }

  it('answers --bg like an older CLI until background sessions are turned on, and lists none', async () => {
    writeScenarioQueue(tmpHome, [{ schemaVersion: 1, actions: [], holdOpenMs: 0 }]);
    expect((await runMock(['--bg'])).code).toBe(1);
    expect(JSON.parse((await runMock(['agents', '--json'])).stdout)).toEqual([]);
    // Neither took the scenario meant for the launch that follows.
    const queue = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.claude-mock', 'scenario-queue.json'), 'utf8'),
    );
    expect(queue).toHaveLength(1);
  });

  it('starts a background worker that plays the scenario, lists it, and attach follows it to its end', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude-mock'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude-mock', 'background-enabled'), '');
    writeScenarioQueue(tmpHome, [{ schemaVersion: 1, actions: [], holdOpenMs: 1_500 }]);

    const started = await runMock(['--bg']);
    expect(started.code).toBe(0);
    const shortId = /backgrounded · ([0-9a-f]{8})/.exec(started.stdout)?.[1];
    expect(shortId).toBeDefined();

    const listed = JSON.parse((await runMock(['agents', '--json'])).stdout) as Array<{
      id: string;
      sessionId: string;
      kind: string;
    }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: shortId, kind: 'background' });
    expect(listed[0].sessionId.startsWith(shortId!)).toBe(true);

    const attached = await runMock(['attach', shortId!]);
    expect(attached.code).toBe(0);
    expect(attached.stdout).toContain(`mock claude session ${listed[0].sessionId.slice(0, 8)}`);
    expect(attached.stdout).toContain(`background session ${shortId} ended`);
    // The session wrote its own transcript, under its own id.
    const projectDir = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
    );
    expect(fs.existsSync(path.join(projectDir, `${listed[0].sessionId}.jsonl`))).toBe(true);
    expect(JSON.parse((await runMock(['agents', '--json'])).stdout)).toEqual([]);
  }, 15_000);

  it('stop ends a background worker and drops it from the list; an unknown id fails', async () => {
    fs.mkdirSync(path.join(tmpHome, '.claude-mock'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude-mock', 'background-enabled'), '');
    writeScenarioQueue(tmpHome, [{ schemaVersion: 1, actions: [], holdOpenMs: 30_000 }]);

    const started = await runMock(['--bg']);
    const shortId = /backgrounded · ([0-9a-f]{8})/.exec(started.stdout)?.[1];
    expect(JSON.parse((await runMock(['agents', '--json'])).stdout)).toHaveLength(1);

    expect((await runMock(['stop', shortId!])).code).toBe(0);
    expect(JSON.parse((await runMock(['agents', '--json'])).stdout)).toEqual([]);
    expect((await runMock(['stop', shortId!])).code).toBe(1);
  }, 15_000);
});
