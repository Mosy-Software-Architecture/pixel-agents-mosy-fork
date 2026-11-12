import { isRecord } from '../../../../../core/src/isRecord.js';
import { SESSION_ID_PATTERN } from '../../../conversations.js';
import {
  CONVERSATION_TITLE_SCAN_BYTES,
  REMOTE_BOT_SESSION_PATTERN,
  REMOTE_LISTING_DAYS,
} from './constants.js';
import { labelFromChunk } from './conversationTitle.js';

/**
 * Claude Code sessions on another machine, read over ssh (remoteHosts.ts runs
 * the script and caches the answer).
 *
 * REMOTE_LISTING_SCRIPT runs on the remote host's python3 and prints one JSON
 * object: the live entries of its session registry (~/.claude/sessions, pid
 * alive), its recent transcripts (~/.claude/projects/*\/*.jsonl written within
 * REMOTE_LISTING_DAYS, or running) with each one's newest title records,
 * working directory and entry point, and its tmux sessions. Only the head and
 * tail of a transcript are read, as conversationTitle does locally, and
 * non-interactive runs (`claude -p`, entry point sdk-cli) are not sent.
 * parseRemoteListing turns that into the sessions the sidebar lists.
 */

/** A Claude Code session on a remote host, as the sidebar lists it. */
export interface RemoteSession {
  sessionId: string;
  /** Its transcript, as a path on the remote host. */
  transcript: string;
  /** Where it started on the remote host: a resume runs there (the CLI files
   *  the transcript under that directory and looks for it there). */
  cwd: string;
  /** When its transcript was last written (ms since the epoch, remote clock). */
  updatedAt: number;
  title: string;
  color?: string;
  /** The transcript's newest title, colour and agent-setting records,
   *  verbatim: the office's copy of the transcript starts with them, so the
   *  label over the character reads them as it reads a local one. */
  labelLines: string[];
  /** Running right now (the remote registry lists it, its process alive). */
  live?: { name?: string; status?: string };
  /** The tmux session it runs in, when it runs in one. */
  tmux?: string;
}

/** The records whose newest copy the script keeps (conversationTitle's). */
const LABEL_TYPES = ['custom-title', 'ai-title', 'agent-color', 'agent-setting', 'last-prompt'];

export const REMOTE_LISTING_SCRIPT = String.raw`
import glob, json, os, re, subprocess, time
SCAN = ${CONVERSATION_TITLE_SCAN_BYTES}
SINCE = time.time() - ${REMOTE_LISTING_DAYS} * 86400
HOME = os.path.expanduser('~/.claude')
LABELS = ${JSON.stringify(LABEL_TYPES)}

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except Exception:
        return False

live = []
for f in glob.glob(os.path.join(HOME, 'sessions', '*.json')):
    try:
        with open(f) as fh:
            d = json.load(fh)
        if isinstance(d, dict) and isinstance(d.get('pid'), int) and alive(d['pid']):
            live.append({k: d.get(k) for k in ('sessionId', 'name', 'status', 'tmux', 'cwd')})
    except Exception:
        pass
live_ids = set(s.get('sessionId') for s in live)

def string_field(key, chunk, index):
    found = re.findall('"' + key + r'":("(?:[^"\\]|\\.)*")', chunk)
    try:
        return json.loads(found[index]) if found else None
    except Exception:
        return None

def scan(chunk, labels):
    for line in chunk.split('\n'):
        if 'title"' not in line and '"agent-' not in line and '"last-prompt"' not in line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if isinstance(r, dict) and r.get('type') in LABELS:
            labels[r['type']] = line

transcripts = []
for p in glob.glob(os.path.join(HOME, 'projects', '*', '*.jsonl')):
    sid = os.path.basename(p)[:-len('.jsonl')]
    try:
        st = os.stat(p)
        if st.st_mtime < SINCE and sid not in live_ids:
            continue
        with open(p, 'rb') as fh:
            fh.seek(max(0, st.st_size - SCAN))
            tail = fh.read(SCAN).decode('utf-8', 'replace')
            fh.seek(0)
            head = fh.read(SCAN).decode('utf-8', 'replace') if st.st_size > SCAN else ''
    except Exception:
        continue
    entrypoint = string_field('entrypoint', tail, -1) or string_field('entrypoint', head, -1)
    if entrypoint == 'sdk-cli':
        continue
    labels = {}
    scan(head, labels)
    scan(tail, labels)
    transcripts.append({
        'sessionId': sid,
        'path': p,
        'mtime': st.st_mtime * 1000,
        # Where it started: the transcript is filed under that directory, and
        # a resume has to run there to find it.
        'cwd': string_field('cwd', head or tail, 0),
        'entrypoint': entrypoint,
        'labels': list(labels.values()),
    })

try:
    out = subprocess.run(['tmux', 'ls', '-F', '#{session_name}'], capture_output=True, text=True, timeout=5)
    tmux = out.stdout.splitlines() if out.returncode == 0 else []
except Exception:
    tmux = []

print(json.dumps({'live': live, 'transcripts': transcripts, 'tmux': tmux}))
`;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The tmux session a live registry entry runs in: its `tmux` field
 *  (`session:@window.%pane`), else a tmux session named like it; only one
 *  the host lists. */
function tmuxSessionOf(
  entry: Record<string, unknown>,
  listed: ReadonlySet<string>,
): string | undefined {
  const fromField = str(entry.tmux)?.split(':')[0];
  if (fromField && listed.has(fromField)) return fromField;
  const name = str(entry.name);
  return name && listed.has(name) ? name : undefined;
}

/**
 * The sessions the script's output lists, newest first, or null when it is
 * not the script's output. Left out: non-interactive runs, bots (a session or
 * tmux name matching REMOTE_BOT_SESSION_PATTERN), and sessions with no title
 * (a running one is titled with its registry name) or no working directory.
 */
export function parseRemoteListing(text: string): RemoteSession[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.transcripts)) return null;
  const tmuxListed = new Set(strings(raw.tmux));
  const live = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(raw.live) ? raw.live : []) {
    if (isRecord(entry) && typeof entry.sessionId === 'string') live.set(entry.sessionId, entry);
  }
  const sessions: RemoteSession[] = [];
  for (const t of raw.transcripts) {
    if (!isRecord(t) || t.entrypoint === 'sdk-cli') continue;
    const sessionId = str(t.sessionId);
    const transcript = str(t.path);
    if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || !transcript) continue;
    if (typeof t.mtime !== 'number') continue;
    const running = live.get(sessionId);
    const name = running && str(running.name);
    const tmux = running && tmuxSessionOf(running, tmuxListed);
    if ([name, tmux].some((n) => n && REMOTE_BOT_SESSION_PATTERN.test(n))) continue;
    const labelLines = strings(t.labels);
    const label = labelFromChunk(labelLines.join('\n'));
    const title = label.title ?? name;
    const cwd = str(t.cwd) ?? (running && str(running.cwd));
    if (!title || !cwd) continue;
    sessions.push({
      sessionId,
      transcript,
      cwd,
      updatedAt: t.mtime,
      title,
      ...(label.color ? { color: label.color } : {}),
      labelLines,
      ...(running
        ? {
            live: {
              ...(name ? { name } : {}),
              ...(str(running.status) ? { status: str(running.status) } : {}),
            },
          }
        : {}),
      ...(tmux ? { tmux } : {}),
    });
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}
