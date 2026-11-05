/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share page wiring (SPEC FR-A2, FR-A3, FR-S9): read the link, remove the token from the address
 * bar, verify the capability set, load the remote document and gate the notebook controls.
 * Pure logic with injected dependencies, so it is testable without a browser.
 */

import { abilitiesOf, describeCapabilities, isReadOnly, ShareAbilities } from "./capabilities";
import { REVOKED_MESSAGE, ShareClient, ShareHttpError, TokenRevokedError } from "./client";
import { ShareEditor } from "./edit";
import { ShareDoc } from "./doc";
import { parseShareLink, ShareLink, stripTokenFromLocation } from "./parse";

export type ShareFailure = "no_link" | "missing_target" | "revoked" | "unauthorized" | "not_found" | "network";

export const FAILURE_MESSAGES: Record<ShareFailure, string> = {
  no_link: "공유 링크가 아닙니다",
  missing_target: "공유 링크에 매니저 주소와 커널 정보가 없습니다",
  revoked: REVOKED_MESSAGE,
  unauthorized: "공유 토큰이 올바르지 않습니다",
  not_found: "공유된 커널을 찾을 수 없습니다",
  network: "매니저에 연결할 수 없습니다",
};

export interface RemoteCell {
  cell_id: string;
  type: string;
  source: string;
  [k: string]: unknown;
}

export interface ShareSession {
  client: ShareClient;
  link: ShareLink;
  abilities: ShareAbilities;
  readOnly: boolean;
  /** Korean one-line description for the banner. */
  banner: string;
  cells: RemoteCell[];
}

export interface PageDeps {
  href: string;
  /** `history.replaceState` wrapper; called with the address without the token. */
  replaceAddress: (url: string) => void;
  clientFactory?: (o: { managerUrl: string; kernelId: string; token: string }) => ShareClient;
}

export class ShareConnectError extends Error {
  constructor(public failure: ShareFailure) {
    super(FAILURE_MESSAGES[failure]);
  }
}

function classify(e: unknown): ShareFailure {
  if (e instanceof TokenRevokedError) return "revoked";
  if (e instanceof ShareHttpError) {
    if (e.status === 401 || e.status === 403) return "unauthorized";
    if (e.status === 404) return "not_found";
  }
  return "network";
}

/** Returns null when the page is not a share link; throws ShareConnectError on failure. */
export async function connectShare(deps: PageDeps): Promise<ShareSession | null> {
  const link = parseShareLink(deps.href);
  if (!link) return null;
  // Remove the token right after reading it (kept only in memory).
  deps.replaceAddress(stripTokenFromLocation(deps.href));
  if (!link.managerUrl || !link.kernelId) throw new ShareConnectError("missing_target");
  const mk = deps.clientFactory ?? ((o) => new ShareClient(o));
  const client = mk({ managerUrl: link.managerUrl, kernelId: link.kernelId, token: link.token });
  try {
    const caps = await client.verify();
    const doc = caps.has("read") ? await client.document() : { cells: [] };
    return {
      client,
      link,
      abilities: abilitiesOf(caps),
      readOnly: isReadOnly(caps),
      banner: (isReadOnly(caps) ? "읽기 전용 공유: " : "공유: ") + describeCapabilities(caps),
      cells: Array.isArray(doc.cells) ? doc.cells : [],
    };
  } catch (e) {
    if (e instanceof ShareConnectError) throw e;
    throw new ShareConnectError(classify(e));
  }
}

/** Remote cells to notebook cells. Cell ids are the remote `cell_id`s. Outputs are not rendered here. */
export function documentToCells(cells: RemoteCell[], editable = false) {
  return cells.map((c) => ({
    id: c.cell_id,
    cellType: c.type === "markdown" || c.type === "preamble" ? "markdown" : "python",
    textContent: c.source,
    // Cells are locked (read-only editors) unless the share has `edit`.
    metadata: { properties: editable ? {} : { locked: true as const }, remote: true },
  }));
}

/** The subset of RuntimeControls that changes or runs cells. */
export interface GateableControls {
  insertCell: (...a: any[]) => any;
  removeCell: (...a: any[]) => any;
  moveCell: (...a: any[]) => any;
  moveCellToIndex: (...a: any[]) => any;
  changeCellType: (...a: any[]) => any;
  setCellProperty: (...a: any[]) => any;
  resetCell: (...a: any[]) => any;
  clearCell: (...a: any[]) => any;
  clearAllCells: (...a: any[]) => any;
  runCell: (...a: any[]) => any;
  runAllCells: (...a: any[]) => any;
}

/**
 * Replace the controls in share mode. Local execution never happens: with `execute`, a cell run is
 * sent to the kernel as a remote run (POST /runs); without it, nothing is sent. Edits are blocked
 * entirely in this version: cell editing over REST is not wired yet, even for `edit` tokens.
 */
export function gateControls(
  controls: GateableControls,
  session: ShareSession,
  onError: (e: unknown) => void,
  editing?: { editor: ShareEditor; doc: ShareDoc }
) {
  const blocked = () => false;
  for (const k of [
    "insertCell",
    "removeCell",
    "moveCell",
    "moveCellToIndex",
    "changeCellType",
    "setCellProperty",
    "resetCell",
    "clearCell",
  ] as const) {
    controls[k] = blocked;
  }
  controls.clearAllCells = () => undefined;
  if (session.abilities.canEdit && editing) {
    // Cell structure edits go to the kernel (needs `edit`); the UI follows the answer. Type and
    // property changes, reset and clear stay blocked: the API has no safe equivalent.
    const { editor, doc } = editing;
    controls.insertCell = (opts: { data?: { textContent?: string }; position: string; adjacentCellId?: string }) => {
      const adj = opts.adjacentCellId;
      void editor.insert({
        source: opts.data?.textContent ?? "",
        ...(opts.position === "after" && adj ? { after: adj } : {}),
        ...(opts.position === "before" && adj ? { before: adj } : {}),
      });
      return false;
    };
    controls.removeCell = (opts: { id: string }) => {
      void editor.remove(opts.id);
      return false;
    };
    controls.moveCellToIndex = (opts: { id: string; toIndex: number }) => {
      void editor.move(opts.id, opts.toIndex);
      return false;
    };
    controls.moveCell = (opts: { id: string; amount: number }) => {
      const i = doc.indexOf(opts.id);
      if (i >= 0) void editor.move(opts.id, i + opts.amount);
      return false;
    };
  }
  const remoteRun = (body: { mode: string; [k: string]: unknown }) => {
    if (!session.abilities.canExecute) return false;
    try {
      session.client.run(body).catch(onError);
    } catch (e) {
      // `need()` throws synchronously when the capability is missing.
      onError(e);
      return false;
    }
    return true;
  };
  controls.runCell = (opts: { id: string }) => remoteRun({ mode: "cells", cell_ids: [opts.id], on_busy: "reject" });
  controls.runAllCells = async () => remoteRun({ mode: "all", on_busy: "reject" });
}

/**
 * Whether the page keeps the sync socket open. The WebSocket needs `read` and nothing more
 * (SPEC FR-A3: "이벤트 스트림과 WebSocket 연결" is `read`), so every readable share is watched: that is
 * how a revoked share is noticed (the kernel closes the streams of a revoked share, FR-A4/PROTOCOL 3.7.4).
 * `history` only decides whether outputs are asked for and shown.
 */
export function shouldWatch(a: ShareAbilities): boolean {
  return a.canRead;
}
