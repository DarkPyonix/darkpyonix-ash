/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place that ends a share page: revoked (REST 401 token_revoked or the socket watch),
 * token no longer valid, or connection lost. Runs once; stops the socket watch (and its pending
 * reconnect), shuts the client so nothing more is sent, clears the editor, blocks the controls and
 * shows one Korean message.
 */

import { REVOKED_MESSAGE, ShareClient } from "./client";
import { ShareEditor } from "./edit";
import { ShareWatch, WatchEnd } from "./watch";

export const END_MESSAGES: Record<WatchEnd, string> = {
  revoked: REVOKED_MESSAGE,
  unauthorized: "공유 토큰이 더 이상 유효하지 않습니다",
  lost: "매니저와 연결이 끊겼습니다. 페이지를 다시 불러오세요",
};

export interface EnderParts {
  client: ShareClient;
  /** Lazy: the watch and editor are created after the ender. */
  watch: () => ShareWatch | undefined;
  editor: () => ShareEditor | undefined;
  blockControls: () => void;
  showStatus: (text: string, isError: boolean) => void;
}

export function createShareEnder(p: EnderParts): (why: WatchEnd) => void {
  let ended = false;
  return (why) => {
    if (ended) return;
    ended = true;
    p.watch()?.stop(); // closes the socket and cancels a pending reconnect
    // Nothing more is sent after this: a revoked share or a dead token would be refused anyway, and a
    // lost connection cannot carry it. Server-side locks expire by themselves (3 minutes, FR-S3).
    p.client.shutdown();
    void p.editor()?.dispose(); // clears timers and pending edits; sends nothing and stays silent
    p.blockControls();
    p.showStatus(END_MESSAGES[why], true);
  };
}
