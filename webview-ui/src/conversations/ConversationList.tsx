import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type {
  Conversation,
  DirectoryConversations,
  RemoteHostConversations,
} from '../../../core/src/messages.js';
import type { TabStatus } from '../components/AgentCard.js';
import { CharacterMugShot } from '../components/CharacterMugShot.js';
import { STATUS_DOT } from '../components/statusDot.js';
import { PixelIcon } from '../components/ui/PixelIcon.js';
import { PixelText } from '../components/ui/PixelText.js';
import {
  CONVERSATION_EXPANDED_KEY,
  CONVERSATION_UNFOLD_MS,
  CONVERSATIONS_PER_DIRECTORY,
  CONVERSATIONS_SHOW_MORE_STEP,
  MUGSHOT_CROP_SIDE_PX,
  RECENT_CONVERSATIONS_COUNT,
} from '../constants.js';
import { prefersReducedMotion } from '../hooks/usePresence.js';
import { useShowDirectoryNames } from '../hooks/useShowDirectoryNames.js';
import { shownDirectoryName } from '../office/directoryNames.js';
import { goesToAgent, liveElsewhereBadge, liveElsewhereTitle } from './liveElsewhere.js';
import { recentSection } from './recent.js';
import {
  remoteCanOpen,
  remoteHostNote,
  remotePage,
  remoteRowTitle,
  remoteShowMore,
  type RemoteShown,
  rowMark,
} from './remote.js';
import { timeAgo } from './timeAgo.js';
import { conversationTitleColor } from './titleColor.js';
import { type ConversationLimits, useConversations } from './useConversations.js';

interface ConversationListProps {
  /** Whether it shows: the list is only fetched (and kept fresh) while it does. */
  open: boolean;
  /** A past conversation pressed, or one whose agent has no terminal here
   *  (Headless): resume it. */
  onResume: (sessionId: string, directoryPath: string) => void;
  /** A running one pressed: go to its agent (as its card would). */
  onOpenAgent: (agentId: number) => void;
  /** A remote host's session pressed: open it (absent: remote hosts aren't listed). */
  onOpenRemote?: (host: string, sessionId: string) => void;
  /** A running conversation's status dot, the same as its agent card's. */
  statusFor: (agentId: number) => TabStatus | null;
  /** Rows sized for a finger (the phone's panel). */
  roomy?: boolean;
  /** Open the search over every conversation (or one Directory's, or one
   *  remote host's). */
  onSearch?: (scope: ConversationSearchScope) => void;
}

/** Where a search looks: every Directory, the one named, or a remote host's
 *  listing (searched as the sidebar holds it). */
export interface ConversationSearchScope {
  directoryPath?: string;
  directoryName?: string;
  remoteHost?: RemoteHostConversations;
}

/**
 * The recent conversations, shared by the desktop sidebar and the phone's
 * panel: first the newest across every Directory ("Recent", each with its
 * Directory's name), then each Directory's own last conversations under a
 * header that expands and collapses it (one open at a time, collapsed until
 * this viewer opens it; remembered per browser). Titled as the coding agent
 * titles them, each with a mug shot of the character its agent wore. One an
 * agent in the office is running shows its status dot, and pressing it goes
 * to that agent; pressing a past one resumes it, and so does pressing one
 * whose agent has no terminal here (Headless: it takes the terminal). Last, each remote host's
 * sessions (remote.ts), pressing one opens it, paged like a Directory.
 * With one Directory, Recent stands in for its section (recentSection).
 */
export function ConversationList({
  open,
  onResume,
  onOpenAgent,
  onOpenRemote,
  statusFor,
  roomy = false,
  onSearch,
}: ConversationListProps) {
  /** What pressing a row does: one an agent with a terminal runs opens that
   *  agent; any other resumes here. */
  const press = (conversation: Conversation, directory: DirectoryConversations) => () =>
    goesToAgent(conversation)
      ? onOpenAgent(conversation.agentId)
      : onResume(conversation.sessionId, directory.path);
  // Conversations per Directory beyond the default five ("Show more"):
  // forgotten when a section opens or shuts, and on reload.
  const [limits, setLimits] = useState<ConversationLimits>({});
  const list = useConversations(open, limits);
  // One open at a time: opening a Directory shuts the one that was open.
  const [openPath, setOpenPath] = useState(storedOpenPath);
  // Rows per remote host group beyond the default five, forgotten as `limits` are.
  const [remoteShown, setRemoteShown] = useState<Readonly<Record<string, RemoteShown>>>({});
  const toggle = (path: string) => {
    const next = openPath === path ? null : path;
    storeOpenPath(next);
    setOpenPath(next);
    setLimits({});
    setRemoteShown({});
  };
  const showMore = (path: string) =>
    setLimits((prev) => ({
      ...prev,
      [path]: (prev[path] ?? CONVERSATIONS_PER_DIRECTORY) + CONVERSATIONS_SHOW_MORE_STEP,
    }));

  // flex-1 even while empty: whatever sits below the list stays at the bottom.
  if (list === null || list.directories.length === 0) {
    return (
      <p className="flex-1 m-0 px-10 py-8 text-sm text-text-muted">
        {list === null ? 'Loading…' : 'No Directories yet.'}
      </p>
    );
  }
  const recent = recentSection(list.directories, RECENT_CONVERSATIONS_COUNT);
  const now = list.receivedAt;
  return (
    <div className="flex-1 min-h-0 quiet-scrollbar">
      {onSearch && <SearchField onPress={() => onSearch({})} roomy={roomy} />}
      <section data-testid="recent-conversations" className="pb-6 border-b-2 border-border">
        <SectionHeading
          action={
            onSearch && recent.rows.length > 0 ? (
              <TextButton testId="conversations-see-all" onPress={() => onSearch({})}>
                See all
              </TextButton>
            ) : undefined
          }
        >
          Recent
        </SectionHeading>
        {recent.rows.length === 0 ? (
          <p className="m-0 px-10 py-2 text-xs text-text-muted">No conversations</p>
        ) : (
          recent.rows.map(({ conversation, directory }) => (
            <ConversationRow
              key={conversation.sessionId}
              conversation={conversation}
              where={directory.name}
              onPress={press(conversation, directory)}
              statusFor={statusFor}
              now={now}
              roomy={roomy}
            />
          ))
        )}
        {recent.more && (
          <ShowMore
            testId="conversations-show-more"
            onPress={() => showMore(list.directories[0].path)}
          />
        )}
      </section>
      {recent.byDirectory && <SectionHeading>By Directory</SectionHeading>}
      {recent.byDirectory &&
        list.directories.map((directory) => (
          <DirectorySection
            key={directory.path}
            directory={directory}
            expanded={openPath === directory.path}
            onToggle={() => toggle(directory.path)}
            now={now}
            press={press}
            statusFor={statusFor}
            roomy={roomy}
            onShowMore={() => showMore(directory.path)}
            onSearch={
              onSearch &&
              (() => onSearch({ directoryPath: directory.path, directoryName: directory.name }))
            }
          />
        ))}
      {onOpenRemote &&
        list.remoteHosts.map((host) => (
          <RemoteHostSection
            key={host.name}
            host={host}
            shown={remoteShown[host.name] ?? {}}
            onShowMore={(group) =>
              setRemoteShown((prev) => ({
                ...prev,
                [host.name]: remoteShowMore(prev[host.name] ?? {}, group),
              }))
            }
            onSearch={onSearch && (() => onSearch({ remoteHost: host }))}
            now={now}
            statusFor={statusFor}
            roomy={roomy}
            onPress={(conversation) =>
              conversation.agentId !== undefined
                ? onOpenAgent(conversation.agentId)
                : onOpenRemote(host.name, conversation.sessionId)
            }
          />
        ))}
    </div>
  );
}

/** A remote host's sessions under its name: running ones marked with the
 *  house in their status, then its services under Services, marked with the
 *  gear; or why there are none (offline, none lately). Each group shows five
 *  rows, then "Show 5 more"; the heading's "See all" searches the host. */
function RemoteHostSection({
  host,
  shown,
  onShowMore,
  onSearch,
  now,
  statusFor,
  roomy,
  onPress,
}: {
  host: RemoteHostConversations;
  shown: RemoteShown;
  onShowMore: (group: keyof RemoteShown) => void;
  onSearch?: () => void;
  now: number;
  statusFor: ConversationListProps['statusFor'];
  roomy: boolean;
  onPress: (conversation: Conversation) => void;
}) {
  const note = remoteHostNote(host);
  const { work, services, moreWork, moreServices } = remotePage(host, shown);
  const row = (conversation: Conversation) => (
    <ConversationRow
      key={conversation.sessionId}
      conversation={conversation}
      remoteHost={host.name}
      onPress={() => onPress(conversation)}
      statusFor={statusFor}
      now={now}
      roomy={roomy}
    />
  );
  return (
    <section data-testid="remote-host" data-host={host.name} className="pb-6">
      <SectionHeading
        action={
          onSearch && !note ? (
            <TextButton testId="remote-host-see-all" onPress={onSearch}>
              See all
            </TextButton>
          ) : undefined
        }
      >
        {host.name}
      </SectionHeading>
      {note ? (
        <p data-testid="remote-host-note" className="m-0 px-10 py-2 text-xs text-text-muted">
          {note}
        </p>
      ) : (
        <>
          {work.map(row)}
          {moreWork && (
            <ShowMore testId="remote-host-show-more" onPress={() => onShowMore('work')} />
          )}
          {services.length > 0 && (
            <div data-testid="remote-host-services">
              <h4 className="m-0 pl-10 pt-6 pb-2 text-2xs font-normal text-text-muted">Services</h4>
              {services.map(row)}
              {moreServices && (
                <ShowMore
                  testId="remote-host-services-show-more"
                  onPress={() => onShowMore('services')}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Looks like a search field; pressing it opens the search (ConversationSearch). */
function SearchField({ onPress, roomy }: { onPress: () => void; roomy: boolean }) {
  return (
    <div className="px-8 pt-8">
      <button
        type="button"
        data-testid="conversations-search"
        onClick={onPress}
        className={`w-full flex items-center gap-6 px-6 ${roomy ? 'py-6' : 'py-3'} bg-bg-dark border-2 border-border rounded-none cursor-text text-left text-sm text-text-muted hover:border-accent`}
      >
        <PixelIcon name="search" scale={1} />
        Search conversations
      </button>
    </div>
  );
}

/** A small text-only button (a heading's "See all", a section's "Show 5 more"). */
function TextButton({
  children,
  onPress,
  testId,
}: {
  children: string;
  onPress: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onPress}
      className="shrink-0 px-2 bg-transparent border-none rounded-none cursor-pointer text-2xs text-text-muted hover:text-text normal-case tracking-normal"
    >
      {children}
    </button>
  );
}

/** "Show 5 more" under a group's rows (a Directory's, Recent's with one
 *  Directory, a remote host's). */
function ShowMore({ onPress, testId }: { onPress: () => void; testId: string }) {
  return (
    <div className="flex pl-8 pr-6 pt-2 pb-2">
      <TextButton testId={testId} onPress={onPress}>
        {`Show ${CONVERSATIONS_SHOW_MORE_STEP} more`}
      </TextButton>
    </div>
  );
}

/** A group's label: small, muted, uppercase-spaced, above its rows; an
 *  `action` (a "See all") at its other end. */
function SectionHeading({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-8 pl-10 pr-8 pt-10 pb-4">
      <h3 className="m-0 text-2xs font-normal tracking-wider uppercase text-text-muted">
        {children}
      </h3>
      {action}
    </div>
  );
}

/** The open Directory, stored as `[path]` (or `[]`). */
function storedOpenPath(): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(CONVERSATION_EXPANDED_KEY) ?? '[]') as unknown;
    const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
    return paths[0] ?? null;
  } catch {
    return null;
  }
}

function storeOpenPath(path: string | null): void {
  try {
    localStorage.setItem(CONVERSATION_EXPANDED_KEY, JSON.stringify(path === null ? [] : [path]));
  } catch {
    // Not remembered; it still expands and collapses.
  }
}

interface SectionProps {
  directory: DirectoryConversations;
  expanded: boolean;
  onToggle: () => void;
  now: number;
  press: (conversation: Conversation, directory: DirectoryConversations) => () => void;
  statusFor: ConversationListProps['statusFor'];
  roomy: boolean;
  /** Lists CONVERSATIONS_SHOW_MORE_STEP more of its conversations. */
  onShowMore: () => void;
  /** Opens the search on this Directory's conversations. */
  onSearch?: () => void;
}

function DirectorySection({
  directory,
  expanded,
  onToggle,
  now,
  press,
  statusFor,
  roomy,
  onShowMore,
  onSearch,
}: SectionProps) {
  const { conversations } = directory;
  const empty = conversations.length === 0;
  const runningIds = conversations.flatMap((c) => (c.agentId !== undefined ? [c.agentId] : []));
  const running = runningIds.length > 0;
  const runningStatus = mostUrgent(runningIds.map(statusFor));
  const latest = empty ? undefined : Math.max(...conversations.map((c) => c.updatedAt));
  return (
    <section className="mx-6 mb-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={directory.path}
        className={`group w-full flex items-center gap-6 px-6 ${roomy ? 'py-6' : 'py-3'} border-2 rounded-none cursor-pointer text-left text-sm leading-tight ${
          expanded ? 'bg-btn-bg border-border' : 'bg-transparent border-transparent hover:bg-btn-bg'
        } ${empty ? 'text-text-muted' : 'text-text'}`}
      >
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {directory.name}
        </span>
        <span
          className={`shrink-0 flex ${expanded ? 'text-accent' : 'text-text-muted group-hover:text-text'}`}
        >
          <PixelIcon name={expanded ? 'down' : 'next'} scale={1} />
        </span>
        {/* Like a row: a running agent's status dot, else how long ago the last one was. */}
        <RowTrail running={running} status={runningStatus} at={latest} now={now} push />
      </button>
      <Unfold open={expanded}>
        {/* A rule along the bottom: where its drawer ends. */}
        {directory.conversations.length === 0 ? (
          <p className="m-0 px-10 py-4 border-b-2 border-border text-xs text-text-muted">
            No conversations
          </p>
        ) : (
          <div className="py-2 border-b-2 border-border">
            {directory.conversations.map((conversation) => (
              <ConversationRow
                key={conversation.sessionId}
                conversation={conversation}
                onPress={press(conversation, directory)}
                statusFor={statusFor}
                now={now}
                roomy={roomy}
              />
            ))}
            {(directory.more || onSearch) && (
              <div className="flex items-center justify-between gap-8 pl-8 pr-6 pt-2 pb-2">
                {directory.more ? (
                  <TextButton testId="conversations-show-more" onPress={onShowMore}>
                    {`Show ${CONVERSATIONS_SHOW_MORE_STEP} more`}
                  </TextButton>
                ) : (
                  <span />
                )}
                {onSearch && (
                  <TextButton testId="conversations-directory-search" onPress={onSearch}>
                    See all
                  </TextButton>
                )}
              </div>
            )}
          </div>
        )}
      </Unfold>
    </section>
  );
}

/**
 * Its children slide open and shut (a grid row growing from 0fr to 1fr, so
 * no height is measured). Shut, they are unmounted, once the fold has played.
 * Whatever is open on first render shows at once, without the slide.
 */
function Unfold({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [unfolded, setUnfolded] = useState(open);
  const instant = prefersReducedMotion();

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (instant) {
        setUnfolded(true);
        return;
      }
      // One frame at 0fr first, or there is nothing to slide from.
      let second = 0;
      const first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => setUnfolded(true));
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    setUnfolded(false);
    if (instant) {
      setMounted(false);
      return;
    }
    const timer = setTimeout(() => setMounted(false), CONVERSATION_UNFOLD_MS);
    return () => clearTimeout(timer);
  }, [open, instant]);

  if (!mounted) return null;
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: unfolded ? '1fr' : '0fr',
        transition: instant ? 'none' : `grid-template-rows ${CONVERSATION_UNFOLD_MS}ms ease-out`,
      }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** The status that most needs the user, of several agents' (null: none known). */
const URGENCY: TabStatus[] = ['attention', 'disconnected', 'working', 'idle'];
function mostUrgent(statuses: Array<TabStatus | null>): TabStatus | null {
  return URGENCY.find((s) => statuses.includes(s)) ?? null;
}

export interface RowProps {
  conversation: Conversation;
  /** The Directory's name, shown under the title (the Recent section). */
  where?: string;
  onPress: () => void;
  statusFor: ConversationListProps['statusFor'];
  now: number;
  roomy: boolean;
  /** The remote host it runs on: a running one is marked with the house. */
  remoteHost?: string;
}

/**
 * One conversation. One still open in a terminal the office did not launch
 * says so under its title (and what it is doing there); pressing it resumes
 * it here all the same, a second process on the same session.
 */
export function ConversationRow({
  conversation,
  where: directoryName,
  onPress,
  statusFor,
  now,
  roomy,
  remoteHost,
}: RowProps) {
  const { title, updatedAt, palette, repeat, agentId, liveElsewhere } = conversation;
  const mark = rowMark(conversation, remoteHost !== undefined, statusFor);
  // Settings → Show Directory Names off: no Directory line (one Directory says nothing).
  const where = shownDirectoryName(directoryName, useShowDirectoryNames());
  // A remote service outside tmux can't be opened at all.
  const disabled = remoteHost !== undefined && !remoteCanOpen(conversation);
  return (
    <button
      type="button"
      data-testid="conversation-row"
      // aria-disabled, not disabled: the tooltip saying why must still show.
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onPress}
      title={
        remoteHost !== undefined
          ? remoteRowTitle(conversation, remoteHost)
          : goesToAgent(conversation)
            ? `Go to "${title}"`
            : agentId !== undefined
              ? `Open a terminal on "${title}" here`
              : `Resume "${title}"`
      }
      className={`w-full flex items-center gap-8 px-10 ${roomy ? 'py-8' : where ? 'py-3' : 'py-5'} bg-transparent border-none rounded-none text-left text-text ${disabled ? 'cursor-default' : 'cursor-pointer hover:bg-btn-bg'}`}
    >
      <span className="shrink-0 flex" style={{ width: MUGSHOT_CROP_SIDE_PX }}>
        {palette !== undefined ? (
          <CharacterMugShot palette={palette} repeat={repeat ?? 0} zoom={1} />
        ) : (
          // Never seen in the office: it gets a character when it resumes.
          <span
            aria-hidden="true"
            className="border-2 border-dashed border-border"
            style={{ width: MUGSHOT_CROP_SIDE_PX, height: MUGSHOT_CROP_SIDE_PX }}
          />
        )}
      </span>
      {/* leading-none: the pixel font's line height opens a wide gap
          between the title and its Directory. */}
      <span className="flex-1 min-w-0 flex flex-col leading-none">
        {/* Tinted with the session's /color, as the label over its character
            is: the same colour means the same session everywhere. */}
        <span
          data-testid="conversation-title"
          className="text-sm overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: conversationTitleColor(conversation) }}
        >
          {title}
        </span>
        {where && (
          <span className="-mt-1 text-2xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap">
            {where}
          </span>
        )}
        {liveElsewhere && (
          <span
            data-testid="conversation-live-elsewhere"
            data-live-kind={liveElsewhere.kind ?? 'interactive'}
            title={liveElsewhereTitle(liveElsewhere)}
            className={`text-2xs ${liveElsewhere.kind === 'background' ? 'text-text-muted' : 'text-warning'} overflow-hidden text-ellipsis whitespace-nowrap`}
          >
            {liveElsewhereBadge(liveElsewhere)}
          </span>
        )}
      </span>
      <RowTrail
        running={mark !== null}
        status={mark?.status ?? null}
        icon={mark?.icon}
        at={updatedAt}
        now={now}
        testId="conversation-status"
      />
    </button>
  );
}

interface RowTrailProps {
  running: boolean;
  status: TabStatus | null;
  /** When it was last written (nothing shows without it). */
  at: number | undefined;
  now: number;
  /** Pushed to the row's end (the header's; a row's title already fills). */
  push?: boolean;
  /** The status dot's test id. */
  testId?: string;
  /** The status's icon: the round dot, or the house (the gear for a service)
   *  of a remote host's row. */
  icon?: 'dot' | 'remote' | 'service';
}

/**
 * A row's end: running, its agent card's status colour in place of the time,
 * as a round dot (a square one reads as a stop button); else how long ago.
 */
function RowTrail({ running, status, at, now, push = false, testId, icon = 'dot' }: RowTrailProps) {
  if (running) {
    return (
      <span
        data-testid={testId}
        data-icon={icon}
        aria-label={status ?? 'running'}
        className={`shrink-0 flex ${push ? 'ml-auto ' : ''}mx-4 ${status ? STATUS_DOT[status] : 'text-text-muted'}`}
      >
        <PixelIcon name={icon} scale={1} />
      </span>
    );
  }
  if (at === undefined) return null;
  return (
    <PixelText
      text={timeAgo(at, now)}
      smaller
      className={`shrink-0 ${push ? 'ml-auto ' : ''}text-xs text-text-muted`}
    />
  );
}
