/**
 * Claude-specific constants. Kept separate from `server/src/constants.ts` so a
 * future single-provider `server/` build doesn't accidentally depend on Claude
 * unless Claude is the active provider.
 *
 * Adding another provider? Create its own `providers/<kind>/<name>/constants.ts`.
 */

/** Output filename after esbuild compiles claude-hook.ts to CJS (source is .ts, output is .js) */
export const CLAUDE_HOOK_SCRIPT_NAME = 'claude-hook.js';

/** Output filename of the status line bridge script (claude-statusline.ts):
 *  runs the user's own status line and reports Claude Code's rate limits. */
export const CLAUDE_STATUSLINE_SCRIPT_NAME = 'claude-statusline.js';

/** Flag before the base64url-encoded command the bridge wraps. */
export const STATUSLINE_WRAP_FLAG = '--wrap';

/** The script name we shipped before the rename to claude-hook.js. Still
 *  recognized as ours so a very old install can be migrated or removed. */
export const LEGACY_HOOK_SCRIPT_NAME = 'pixel-agents-hook.js';

/** Hook events to install in ~/.claude/settings.json. This list is the whole
 *  data-collection surface: Claude Code POSTs each of these payloads to the
 *  local server, so an event we do not act on is scope we should not ask for.
 *  SessionStart/SessionEnd handle session lifecycle (start, /clear, resume, exit).
 *  Stop/PermissionRequest/Notification handle turn completion and permission UI.
 *  SubagentStart/SubagentStop/TeammateIdle/TaskCompleted power Agent Teams.
 *
 *  Deliberately NOT installed: UserPromptSubmit and TaskCreated. Both normalize
 *  to null (nothing in the runtime consumes them), so installing them only
 *  forwarded the user's prompt text and task payloads to the server to be
 *  dropped. A legacy install that still carries them is migrated on the next
 *  install (see installEntries' unlisted-event sweep). */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'PermissionRequest',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
] as const;

/** Suffix of the one-time pre-modification backup of settings.json. Brand-named
 *  rather than a generic `.backup`, which collides with other tools' backup
 *  convention: a foreign `.backup` sitting next to settings.json must not make
 *  us believe we already saved the user's original. */
export const SETTINGS_BACKUP_SUFFIX = '.pixel-agents.backup';

/** Suffix of the temp file used for the atomic tmp-write + rename. */
export const SETTINGS_TMP_SUFFIX = '.pixel-agents-tmp';

/** Mode for a settings.json we create ourselves. An existing file's mode is
 *  preserved instead; this is only the fresh-file default, and it is the
 *  restrictive one because the file holds the user's permission rules. */
export const SETTINGS_FRESH_FILE_MODE = 0o600;

/** Attempts for the settings.json read-modify-write cycle. Claude Code writes
 *  the same file and does not coordinate with us, so the cycle re-reads the
 *  file immediately before committing and retries when it changed. The verify
 *  sits after mkdir/backup/tmp-write, so the residual lost-update window is one
 *  read plus one rename — narrowed, NOT eliminated: a Claude Code write landing
 *  inside that gap is still overwritten by our rename. A lockfile would not
 *  help (Claude Code would not honor it, and stale locks add failure modes
 *  worse than the race). */
export const SETTINGS_MUTATE_ATTEMPTS = 3;
/** Delay between settings.json mutation attempts (lets a concurrent writer finish). */
export const SETTINGS_MUTATE_RETRY_DELAY_MS = 100;

/** Terminal name prefix used when launching Claude Code in VS Code.
 *  Used by the extension to match terminals to agents for adoption. */
export const CLAUDE_TERMINAL_NAME_PREFIX = 'Claude Code';

// ── Context windows (per model, in tokens) ──────────────────
//
// Transcripts report token usage but never the window it counts against, so
// these are the denominators behind every context gauge. Measured against
// real transcripts, where the largest context seen per model was: opus-4-8
// 957k, fable-5 788k, opus-5 459k, sonnet-5 233k -- every current model runs
// the large window. Haiku is the small-window exception.
/** Current Claude models (Opus/Sonnet/Fable 5, Opus 4.8). */
export const CLAUDE_LARGE_CONTEXT_WINDOW = 1_000_000;
/** Haiku, and older models that never got the large window. */
export const CLAUDE_SMALL_CONTEXT_WINDOW = 200_000;
/** Model ids that run the small window. Everything else gets the large one:
 *  guessing small for a large model pins every gauge in the red, while the
 *  reverse is a quiet under-read that the runtime's widening still corrects. */
export const CLAUDE_SMALL_CONTEXT_MODEL_PATTERN = /haiku|claude-[123]|-4-[01]\b/i;

/** Tools that spawn a sub-agent (the provider's subagentToolNames). */
export const CLAUDE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

/** Bytes read from each end of a transcript looking for its title. */
export const CONVERSATION_TITLE_SCAN_BYTES = 256 * 1024;
/** A title longer than this is cut, with an ellipsis. */
export const CONVERSATION_TITLE_MAX_CHARS = 120;
/** The /color name that resets a session's colour (no colour). */
export const CLAUDE_DEFAULT_AGENT_COLOR = 'default';

/** Claude Code's live-process registry: one `<pid>.json` per running CLI,
 *  under its config directory (`$CLAUDE_CONFIG_DIR`, else ~/.claude). */
export const CLAUDE_SESSIONS_DIR_NAME = 'sessions';
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
/** A registry entry's `kind` for a background session's worker (`claude --bg`);
 *  its `jobId` is the short id `claude attach` takes. */
export const CLAUDE_REGISTRY_BACKGROUND_KIND = 'bg';

// ── Background sessions (`claude --bg`, Claude Code 2.1.x) ─────
/** The CLI the office launches and asks. */
export const CLAUDE_COMMAND = 'claude';
/** Every live session, interactive and background, as JSON (`claude agents --json`):
 *  the one source that also lists a background session whose worker has not
 *  registered (a startup dialog) or is not running (attaching starts it). */
export const CLAUDE_AGENTS_LIST_ARGS: readonly string[] = ['agents', '--json'];
/** How old the last `claude agents --json` answer may be before a read asks again
 *  (in the background: a read never waits for the CLI). */
export const CLAUDE_AGENTS_LIST_MAX_AGE_MS = 3_000;
/** After a failed ask (no such command in an older CLI, a timeout), how long
 *  before asking again. */
export const CLAUDE_AGENTS_LIST_RETRY_MS = 60_000;
/** How long one `claude agents --json` may take. */
export const CLAUDE_AGENTS_LIST_TIMEOUT_MS = 5_000;
/** Biggest answer read from it. */
export const CLAUDE_AGENTS_LIST_MAX_BYTES = 4 * 1024 * 1024;
/** Start a session in the background service (`claude --bg`); it prints
 *  `backgrounded · <short id>` and returns. */
export const CLAUDE_BACKGROUND_FLAG = '--bg';
/** How long `claude --bg` may take (it starts the service when none runs). */
export const CLAUDE_BACKGROUND_START_TIMEOUT_MS = 20_000;
/** Asks of the session list for a just-started background session's full id,
 *  and the pause between them (it may not be listed at once). */
export const CLAUDE_BACKGROUND_LOOKUP_ATTEMPTS = 10;
export const CLAUDE_BACKGROUND_LOOKUP_INTERVAL_MS = 300;
/** Stop a background session (`claude stop <short id>`): its worker ends, its
 *  conversation stays (`claude attach <id>` would start it again). Exits 1
 *  with "No job matching '<id>'" on stderr for an id it does not know. */
export const CLAUDE_STOP_COMMAND = 'stop';
/** How long `claude stop` may take. */
export const CLAUDE_STOP_TIMEOUT_MS = 15_000;

/** How far back a remote host's past sessions are listed (remoteListing.ts):
 *  transcripts written within this many days, besides the running ones. */
export const REMOTE_LISTING_DAYS = 7;

/** A remote session whose name starts with this is a service (a bot, a
 *  watcher), launched as `claude --name svc-<service>`: the sidebar lists it
 *  under Services, and opening it attaches to its tmux, never resumes it (the
 *  same rule as `agent remote --all`). */
export const REMOTE_SERVICE_NAME_PREFIX = 'svc-';

// ── Usage endpoint (the usage bars' second source) ─────────────
/** The account usage endpoint Claude Code's `/usage` reads. */
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** The beta header that endpoint requires for an OAuth bearer. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
/** How long one read of the endpoint may take. */
export const CLAUDE_OAUTH_USAGE_TIMEOUT_MS = 8_000;
/** Where Claude Code keeps its OAuth credentials on macOS (a generic keychain item). */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Where it keeps them elsewhere, under its config directory. */
export const CLAUDE_CREDENTIALS_FILE_NAME = '.credentials.json';
/** How long reading the keychain may take. */
export const CLAUDE_KEYCHAIN_TIMEOUT_MS = 5_000;

// ── Done marks (session-marks.json) ────────────────────────────
/** The done marks, under the config directory: `{ version: 1, marks: {
 *  <sessionId>: { done: <ISO-8601>, by: feature-flow | office | cli } } }`.
 *  Written by the office, feature-flow and the `agent` CLI alike. */
export const SESSION_MARKS_FILE_NAME = 'session-marks.json';
/** The format this office reads and writes; it never rewrites a newer one. */
export const SESSION_MARKS_VERSION = 1;
/** Who wrote a mark, for the marks the office writes. */
export const SESSION_MARKS_BY_OFFICE = 'office';
/** Where Claude Code files transcripts under its config directory
 *  (`projects/<project>/<sessionId>.jsonl`). */
export const CLAUDE_PROJECTS_DIR_NAME = 'projects';
/** A marked session's transcript is read backwards from its end looking for a
 *  user prompt after the mark, at most this far (past it the mark holds). */
export const SESSION_MARK_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** How old the session id → transcript index may get before a session it
 *  doesn't know makes it read the projects directory again. */
export const SESSION_MARKS_INDEX_MAX_AGE_MS = 5_000;
/** User text that voids no done mark: local commands and their output, and
 *  what Claude Code feeds the model on its own. The same list as the
 *  toolkit's session-marks.py, so both sides agree on which marks hold
 *  (`<bash-input>`, the user typing `!cmd`, IS a prompt there). */
export const NOT_A_PROMPT_PREFIXES: readonly string[] = [
  '<command-name>',
  '<command-message>',
  '<local-command-',
  '<bash-stdout>',
  '<bash-stderr>',
  '<task-notification>',
  '<system-reminder>',
];
/** A user record's `origin.kind` for text Claude Code writes as the user's
 *  but nobody typed: a background task's notice, a peer session's message. */
export const NOT_A_PROMPT_ORIGINS: readonly string[] = ['task-notification', 'peer'];
