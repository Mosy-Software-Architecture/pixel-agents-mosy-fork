import { useCallback } from 'react';

import { openRemoteConversation, resumeConversation } from '../conversations/useConversations.js';
import { transport } from '../transport/index.js';
import type { Directory } from './useExtensionMessages.js';

/**
 * Launching an agent, resuming a conversation and opening a remote host's
 * session, from either shell. Each
 * tell the terminal drawer first (`expectLaunch`), so the agent's terminal
 * opens focused once the server announces it.
 */
export function useLaunchActions(expectLaunch: () => void) {
  // palette: the character picked from the roster (absent = the Directory's
  // default characters, else a random pick, server-side).
  const launch = useCallback(
    (directory: Directory, palette?: number) => {
      expectLaunch();
      transport.send({ type: 'launchAgent', directoryPath: directory.path, palette });
    },
    [expectLaunch],
  );
  const resume = useCallback(
    (sessionId: string, directoryPath: string) => {
      expectLaunch();
      resumeConversation(sessionId, directoryPath);
    },
    [expectLaunch],
  );
  const openRemote = useCallback(
    (host: string, sessionId: string) => {
      expectLaunch();
      openRemoteConversation(host, sessionId);
    },
    [expectLaunch],
  );
  return { launch, resume, openRemote };
}
