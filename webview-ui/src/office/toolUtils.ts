/** Map status prefixes back to tool names (animation selection, activity
 *  icons). The statuses are the provider's `formatToolStatus` lines; a more
 *  specific prefix comes before a shorter one it starts with. */
const STATUS_TO_TOOL: Record<string, string> = {
  Reading: 'Read',
  'Searching the web': 'WebSearch',
  'Searching files': 'Glob',
  Searching: 'Grep',
  Fetching: 'WebFetch',
  'Editing notebook': 'NotebookEdit',
  Writing: 'Write',
  Editing: 'Edit',
  'Running subtask': 'Task',
  Running: 'Bash',
  Subtask: 'Task',
  Task: 'Task',
  'Sending message': 'SendMessage',
  '-> ': 'SendMessage',
  'Waiting for your answer': 'AskUserQuestion',
  Planning: 'EnterPlanMode',
  'Creating team': 'TeamCreate',
};

export function extractToolName(status: string): string | null {
  for (const [prefix, tool] of Object.entries(STATUS_TO_TOOL)) {
    if (status.startsWith(prefix)) return tool;
  }
  // Any other tool reads "Using <name>" (an MCP tool, ToolSearch, Skill...).
  if (status.startsWith('Using ')) return status.slice('Using '.length).trim() || null;
  const first = status.split(/[\s:]/)[0];
  return first || null;
}

// ── Provider capabilities (tool taxonomy for rendering decisions) ────────────
// Populated once by the `providerCapabilities` postMessage after `webviewReady`.
// Modules classifying tools (character animation, subagent creation gate) read
// from here instead of hardcoding Claude-specific tool names.

const providerCaps: {
  readingTools: Set<string>;
  subagentToolNames: Set<string>;
} = {
  readingTools: new Set(),
  subagentToolNames: new Set(),
};

export function setProviderCapabilities(caps: {
  readingTools: string[];
  subagentToolNames: string[];
}): void {
  providerCaps.readingTools = new Set(caps.readingTools);
  providerCaps.subagentToolNames = new Set(caps.subagentToolNames);
}

export function isReadingToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.readingTools.has(name);
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  return typeof name === 'string' && providerCaps.subagentToolNames.has(name);
}
