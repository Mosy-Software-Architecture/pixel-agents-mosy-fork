/**
 * User records that are not a prompt to the model: a local command run in
 * Claude Code itself (`/model`, `/color`, `/compact`'s own record, `!cmd`) and
 * its output, or the summary a compaction leaves. Claude Code writes them as
 * user text, but no model turn follows, so no turn_duration ever ends them.
 * A custom command (a skill) is written the same way; the model's reply to it
 * marks the agent active on its own.
 *
 * Shapes, from real transcripts: the text starts with one of the tags below
 * (`<command-message>` comes first for some custom commands), and a compaction
 * summary carries `isCompactSummary: true`.
 */

const LOCAL_COMMAND_TAGS = [
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
];

/** Whether a user record starts no turn (HookProvider.startsNoTurn). */
export function startsNoTurn(record: unknown): boolean {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as {
    type?: unknown;
    isCompactSummary?: unknown;
    message?: { content?: unknown };
  };
  if (r.type !== 'user') return false;
  if (r.isCompactSummary === true) return true;
  const content = r.message?.content;
  if (typeof content !== 'string') return false;
  const text = content.trimStart();
  return LOCAL_COMMAND_TAGS.some((tag) => text.startsWith(tag));
}
