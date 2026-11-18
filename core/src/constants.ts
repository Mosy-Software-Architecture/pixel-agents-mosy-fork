/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
/** Path prefix for a provider's account usage reports (`/api/usage/:providerId`),
 *  sent by the status line bridge. Bearer-authenticated like the hook route. */
export const USAGE_API_PREFIX = '/api/usage';
/** Length of a weekly usage window (and of a model's share of it, which resets
 *  with it). The usage endpoint gives only `resetsAt`, never a start, so the
 *  window is taken to be the 7 days before its reset: start = resetsAt - this. */
export const USAGE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Terminal (standalone embedded terminal) ──────────────────
// The raw PTY byte stream deliberately lives OUTSIDE the AsyncAPI contract --
// it is a data plane (unstructured, high-frequency), not a control plane.
// Only the terminal's control-plane facts (availability, session open/close)
// are AsyncAPI ServerMessages. See docs/design/standalone-terminal.md.

/** Path prefix for the per-agent terminal WebSocket: `/terminal/:agentId`. The
 *  handshake carries the server token as `?token=`, exactly like `/ws` (see
 *  server/src/wsAuth.ts); the frame shapes are in terminalFrames.ts. */
export const TERMINAL_WS_PREFIX = '/terminal';

// ── Transport ────────────────────────────────────────────────
// Connection-state names for the MessageTransport state machine.

export const TRANSPORT_STATE_CONNECTING = 'connecting';
export const TRANSPORT_STATE_CONNECTED = 'connected';
export const TRANSPORT_STATE_RECONNECTING = 'reconnecting';
export const TRANSPORT_STATE_DISCONNECTED = 'disconnected';
