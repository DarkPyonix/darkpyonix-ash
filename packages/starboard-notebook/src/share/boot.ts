/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Runtime } from "../types";
import { documentToCells, connectShare, gateControls, ShareConnectError, ShareSession } from "./page";
import { parseShareLink } from "./parse";
import { outputsToElement } from "./outputs";
import { ShareWatch } from "./watch";
import { ShareDoc, DocChange } from "./doc";
import { ShareEditor } from "./edit";
import { arrayMoveElement } from "../components/helpers/array";

/** Show `outputs` under the cell (a `.share-output` child of the cell element, replaced each time). */
function showOutputs(rt: Runtime, cellId: string, outputs: unknown) {
  const cellEl = rt.dom.getCellById(cellId);
  if (!cellEl) return;
  cellEl.querySelector(":scope > .share-output")?.remove();
  cellEl.append(outputsToElement(document, outputs));
}

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
      const editable = session.abilities.canEdit && session.abilities.canRead;
      const doc = new ShareDoc(session.cells);
      const outputsCache = new Map<string, unknown>();
      const watchedIds = new Set<string>();
      const err = (msg: string) => showStatus(msg, true);
      let editor: ShareEditor | undefined;

      /** Local edits of a cell go to the editor (debounced lock + PATCH). */
      const watchCell = (id: string) => {
        if (!editable || watchedIds.has(id)) return;
        watchedIds.add(id);
        rt.controls.subscribeToCellChanges(id, () => {
          const cell = rt.content.cells.find((c) => c.id === id);
          if (cell) editor?.localChange(id, cell.textContent);
        });
      };
      const reshowOutputs = () =>
        rt.dom.notebook.updateComplete.then(() => outputsCache.forEach((o, id) => showOutputs(rt, id, o)));

      const applyChange = (ch: DocChange) => {
        const cells = rt.content.cells;
        if (ch.kind === "created") {
          cells.splice(ch.index, 0, ...(documentToCells([ch.cell], editable) as any));
          watchCell(ch.cell.cell_id);
        } else if (ch.kind === "updated") {
          if (editor?.hasPending(ch.cell.cell_id)) return; // our unsent edit wins until it is sent
          const i = cells.findIndex((c) => c.id === ch.cell.cell_id);
          if (i < 0) return;
          cells[i] = documentToCells([ch.cell], editable)[0] as any;
          rt.dom.getCellById(ch.cell.cell_id)?.remove();
        } else if (ch.kind === "deleted") {
          const i = cells.findIndex((c) => c.id === ch.cellId);
          if (i >= 0) cells.splice(i, 1);
          outputsCache.delete(ch.cellId);
        } else if (ch.kind === "moved") {
          const from = cells.findIndex((c) => c.id === ch.cell.cell_id);
          if (from >= 0) {
            arrayMoveElement(cells, from, ch.index);
            rt.dom.notebook.moveCellDomElement(from, ch.index);
          }
        } else if (ch.kind === "reloaded") {
          cells.length = 0;
          cells.push(...(documentToCells(ch.cells, editable) as any));
          rt.dom.cells.forEach((c) => c.remove());
          ch.cells.forEach((c) => watchCell(c.cell_id));
        }
        rt.dom.notebook.requestUpdate();
        void reshowOutputs();
      };

      if (editable) {
        editor = new ShareEditor(session.client, doc, {
          onError: err,
          onChange: applyChange,
          onSaved: () => undefined, // our own save only bumps the version: the editor keeps focus and cursor
          onConflict: (id) => {
            // Show the server's version of the cell that was edited elsewhere first.
            session.client
              .document()
              .then((d: any) => {
                const c = (d.cells ?? []).find((x: any) => x.cell_id === id);
                if (c) {
                  doc.cells[doc.indexOf(id)] = c;
                  const i = rt.content.cells.findIndex((x) => x.id === id);
                  if (i >= 0) rt.content.cells[i] = documentToCells([c], editable)[0] as any;
                  rt.dom.getCellById(id)?.remove();
                  rt.dom.notebook.requestUpdate();
                  void reshowOutputs();
                }
              })
              .catch(() => undefined);
          },
        });
        window.addEventListener("pagehide", () => void editor?.dispose(true), { once: true });
        // Leaving with an unsent edit asks the browser to confirm (the edit would be lost).
        window.addEventListener("beforeunload", (ev) => {
          if (editor?.hasUnsaved()) {
            ev.preventDefault();
            ev.returnValue = false;
          }
        });
      }
      gateControls(
        rt.controls as any,
        session,
        (e) => err(`실행하지 못했습니다: ${(e as Error).message}`),
        editor && { editor, doc }
      );
      rt.content.cells.push(...(documentToCells(session.cells, editable) as any));
      session.cells.forEach((c) => watchCell(c.cell_id));
      rt.dom.notebook.requestUpdate();
      if (session.abilities.canExecute) {
        rt.dom.notebook.shareInterrupt = () =>
          session.client.interrupt().catch((e: unknown) => err(`중단하지 못했습니다: ${(e as Error).message}`));
      }
      showStatus(session.banner, false);

      if (!session.abilities.canSeeOutputs && !editable) return;
      const put = (id: string, outs: unknown) => {
        outputsCache.set(id, outs);
        showOutputs(rt, id, outs);
      };
      if (session.abilities.canSeeOutputs) {
        rt.dom.notebook.updateComplete.then(() => {
          for (const c of session.cells) put(c.cell_id, (c as any).outputs ?? []);
        });
      }
      /** Block every operation of the share page (run, edit, interrupt). */
      const blockAll = () => {
        const blocked = () => false;
        for (const k of ["runCell", "insertCell", "removeCell", "moveCell", "moveCellToIndex"] as const) {
          (rt.controls as any)[k] = blocked;
        }
        rt.controls.runAllCells = async () => false;
        rt.dom.notebook.shareInterrupt = undefined;
      };
      const watch = new ShareWatch(session.client, {
        onOutputs: (id, outs) => {
          if (session.abilities.canSeeOutputs) put(id, outs);
        },
        onEvent: (type, data) => {
          const ch = doc.apply(type, data);
          if (ch) applyChange(ch);
        },
        onState: (st) => showStatus(`${session.banner}${st === "reconnecting" ? " (다시 연결하는 중...)" : ""}`, false),
        onEnd: (why) => {
          blockAll();
          void editor?.dispose(); // free locks and stop retries; errors are swallowed
          showStatus(
            why === "revoked"
              ? "공유가 폐기되었습니다"
              : why === "unauthorized"
              ? "공유 토큰이 더 이상 유효하지 않습니다"
              : "매니저와 연결이 끊겼습니다. 페이지를 다시 불러오세요",
            true
          );
        },
      });
      // Restored from the back/forward cache: the socket and editor were closed on pagehide and the
      // token is no longer in the address bar, so the page cannot reconnect by itself.
      window.addEventListener("pageshow", (ev) => {
        if (!ev.persisted) return;
        blockAll();
        showStatus("페이지가 이전 상태로 복원되었습니다. 공유 링크로 다시 접속하세요", true);
      });
      watch.start();
      window.addEventListener("pagehide", () => watch.stop(), { once: true });
    })
    .catch((e) => {
      showStatus(e instanceof ShareConnectError ? e.message : "공유에 연결하지 못했습니다", true);
    });
  return true;
}
