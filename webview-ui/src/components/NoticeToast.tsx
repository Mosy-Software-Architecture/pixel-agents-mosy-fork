import { useSyncExternalStore } from 'react';

import { currentNotice, dismissNotice, subscribeNotices } from '../office/notices.js';

/** The office's notice (office/notices.ts), top centre over everything; a
 *  press dismisses it. */
export function NoticeToast() {
  const notice = useSyncExternalStore(subscribeNotices, currentNotice);
  if (!notice) return null;
  return (
    <div className="fixed top-[18%] left-0 right-0 z-100 flex justify-center pointer-events-none px-16">
      <button
        type="button"
        key={notice.seq}
        data-testid="office-notice"
        role="status"
        onClick={dismissNotice}
        className="pixel-panel pointer-events-auto max-w-full py-6 px-12 text-sm text-text text-left cursor-pointer rounded-none"
      >
        {notice.text}
      </button>
    </div>
  );
}
