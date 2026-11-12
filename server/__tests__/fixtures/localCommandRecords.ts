/**
 * User records Claude Code writes for things that are not prompts to the
 * model, shaped as in real transcripts (2026-11, Claude Code 2.1.x; ids,
 * paths and output shortened). None of them is followed by a model turn or a
 * turn_duration: `/model` run in the prompt (caveat, command, its output),
 * a `!` shell command and its output, and the summary a compaction leaves.
 */

const SESSION = '0f0e0d0c-0b0a-4908-8706-050403020100';

function userRecord(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/work',
    sessionId: SESSION,
    version: '2.1.309',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content },
    uuid: `u-${content.length}`,
    timestamp: '2026-11-12T10:00:00.000Z',
    ...extra,
  };
}

export const localCommandCaveat = userRecord(
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>",
  { isMeta: true },
);

export const modelCommand = userRecord(
  '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>',
);

export const modelCommandOutput = userRecord(
  '<local-command-stdout>Set model to `Opus 5 (1M context) (default)`</local-command-stdout>',
);

/** A custom command (a skill) puts its message tag first; the model replies to it. */
export const skillCommand = userRecord(
  '<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>2h /workspace-digest</command-args>',
);

export const bashInput = userRecord('<bash-input> git status</bash-input>');

export const bashOutput = userRecord(
  '<bash-stdout>On branch main\nnothing to commit, working tree clean</bash-stdout><bash-stderr></bash-stderr>',
);

export const compactSummary = userRecord(
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent: ...',
  { isCompactSummary: true, isVisibleInTranscriptOnly: true },
);

export const plainPrompt = userRecord('check the build');
