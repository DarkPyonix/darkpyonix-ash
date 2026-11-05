/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Runtime } from "../types";
import { documentToCells, connectShare, gateControls, ShareConnectError, ShareSession } from "./page";
import { parseShareLink } from "./parse";

/**
 * Called from setupRuntime. If the page URL is a share link (token in `#` or `?token=`), the
 * notebook switches to share mode: no local content or execution, the token leaves the address
 * bar, and the remote document is shown under the capability gates (SPEC FR-A2, FR-A3).
 * Returns true if share mode is active.
 */
export function bootShare(rt: Runtime, showStatus: (text: string, isError: boolean) => void): boolean {
  if (!parseShareLink(window.location.href)) return false;

  // Synchronously: nothing local may run or show while the connection is made.
  rt.content.cells.length = 0;
  const noop = () => false;
  rt.controls.runCell = noop;
  rt.controls.runAllCells = async () => false;
  showStatus("공유에 연결하는 중...", false);

  connectShare({
    href: window.location.href,
    replaceAddress: (url) => window.history.replaceState(null, "", url),
  })
    .then((session: ShareSession | null) => {
      if (!session) return;
      gateControls(rt.controls as any, session, (e) =>
        showStatus(`실행하지 못했습니다: ${(e as Error).message}`, true)
      );
      rt.content.cells.push(...(documentToCells(session.cells) as any));
      rt.dom.notebook.requestUpdate();
      showStatus(session.banner, false);
    })
    .catch((e) => {
      showStatus(e instanceof ShareConnectError ? e.message : "공유에 연결하지 못했습니다", true);
    });
  return true;
}
