/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cell editing over REST for a share with `edit` (SPEC FR-A3, FR-S2, FR-S3, FR-S8): lock the cell,
 * PATCH with `base_version`, release the lock after a quiet period. Every call goes through
 * ShareClient, which refuses to send without the capability (default-deny). Edits to one cell are
 * serialized.
 */

import { ShareClient, ShareHttpError } from "./client";
import { DocChange, DocCell, ShareDoc } from "./doc";

export interface EditorOptions {
  /** Wait after the last keystroke before sending. Default 800. */
  debounceMs?: number;
  /** Release the lock after this long without edits. Default 5000. */
  idleUnlockMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

export interface EditorHandlers {
  /** Korean message for the status line. */
  onError: (message: string) => void;
  /** A change made by our own REST call (not yet seen over the socket). */
  onChange: (c: DocChange) => void;
  /** The cell changed elsewhere first: the caller should show the server's version. */
  onConflict: (cellId: string) => void;
}

export function editErrorMessage(e: unknown): string {
  if (e instanceof ShareHttpError) {
    if (e.status === 409 && e.code === "locked") return "다른 사용자가 수정 중인 셀입니다";
    if (e.status === 409) return "다른 곳에서 먼저 수정되어 변경을 저장하지 못했습니다";
    if (e.status === 403) return "이 공유에는 코드를 수정할 권한이 없습니다";
    if (e.status === 401) return "공유 토큰이 더 이상 유효하지 않습니다";
  }
  return "변경을 저장하지 못했습니다";
}

export class ShareEditor {
  private pending = new Map<string, string>();
  private timers = new Map<string, unknown>();
  private idle = new Map<string, unknown>();
  private locked = new Set<string>();
  private chain = new Map<string, Promise<void>>();

  constructor(
    private client: ShareClient,
    private doc: ShareDoc,
    private h: EditorHandlers,
    private o: EditorOptions = {}
  ) {}

  private set(fn: () => void, ms: number) {
    return (this.o.setTimeoutImpl ?? setTimeout)(fn, ms);
  }
  private clear(t: unknown) {
    if (t !== undefined) (this.o.clearTimeoutImpl ?? clearTimeout)(t as any);
  }

  hasPending(cellId: string) {
    return this.pending.has(cellId);
  }

  /** Called on every local change of a cell's text. */
  localChange(cellId: string, source: string) {
    if (this.doc.indexOf(cellId) < 0) return;
    this.pending.set(cellId, source);
    this.clear(this.timers.get(cellId));
    this.timers.set(
      cellId,
      this.set(() => void this.flush(cellId), this.o.debounceMs ?? 800)
    );
  }

  private enqueue(cellId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chain.get(cellId) ?? Promise.resolve()).then(fn, fn);
    this.chain.set(cellId, next);
    return next;
  }

  flush(cellId: string): Promise<void> {
    this.clear(this.timers.get(cellId));
    this.timers.delete(cellId);
    return this.enqueue(cellId, async () => {
      const source = this.pending.get(cellId);
      if (source === undefined) return;
      try {
        if (!this.locked.has(cellId)) {
          await this.client.lockCell(cellId);
          this.locked.add(cellId);
        }
        const base = this.doc.versionOf(cellId);
        if (base === undefined) {
          this.pending.delete(cellId);
          return;
        }
        const cell = (await this.client.updateCell(cellId, { base_version: base, source })) as DocCell;
        if (this.pending.get(cellId) === source) this.pending.delete(cellId);
        const ch = cell ? this.doc.applyResult("updated", cell) : null;
        if (ch) this.h.onChange(ch);
        this.scheduleUnlock(cellId);
      } catch (e) {
        if (e instanceof ShareHttpError && e.status === 409 && e.code !== "locked") {
          this.pending.delete(cellId);
          this.locked.delete(cellId);
          this.h.onConflict(cellId);
        } else if (e instanceof ShareHttpError && e.status === 409) {
          this.locked.delete(cellId);
        }
        this.h.onError(editErrorMessage(e));
      }
    });
  }

  private scheduleUnlock(cellId: string) {
    this.clear(this.idle.get(cellId));
    this.idle.set(
      cellId,
      this.set(() => void this.release(cellId), this.o.idleUnlockMs ?? 5000)
    );
  }

  /** Release the lock of a cell (after pending edits are sent). */
  release(cellId: string): Promise<void> {
    this.clear(this.idle.get(cellId));
    this.idle.delete(cellId);
    return this.enqueue(cellId, async () => {
      if (!this.locked.has(cellId)) return;
      this.locked.delete(cellId);
      try {
        await this.client.unlockCell(cellId);
      } catch (e) {
        this.h.onError(editErrorMessage(e));
      }
    });
  }

  async insert(opts: { source?: string; type?: string; after?: string; before?: string }): Promise<string | false> {
    try {
      const cell = (await this.client.createCell(opts)) as DocCell;
      const ch = this.doc.applyResult("created", cell);
      if (ch) this.h.onChange(ch);
      return cell.cell_id;
    } catch (e) {
      this.h.onError(editErrorMessage(e));
      return false;
    }
  }

  async remove(cellId: string): Promise<boolean> {
    const v = this.doc.versionOf(cellId);
    if (v === undefined) return false;
    try {
      await this.client.deleteCell(cellId, v);
      const ch = this.doc.apply("doc.cell.deleted", { cell_id: cellId });
      if (ch) this.h.onChange(ch);
      return true;
    } catch (e) {
      this.h.onError(editErrorMessage(e));
      return false;
    }
  }

  async move(cellId: string, toIndex: number): Promise<boolean> {
    try {
      const cell = (await this.client.moveCell(cellId, Math.max(1, toIndex))) as DocCell;
      const ch = this.doc.applyResult("moved", cell);
      if (ch) this.h.onChange(ch);
      return true;
    } catch (e) {
      this.h.onError(editErrorMessage(e));
      return false;
    }
  }

  /** Send what is pending and release every lock (pagehide, revoked share). */
  async dispose() {
    for (const id of [...this.pending.keys()]) await this.flush(id);
    for (const id of [...this.locked]) await this.release(id);
  }
}
