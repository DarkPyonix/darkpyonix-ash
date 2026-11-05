/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cell editing over REST for a share with `edit` (SPEC FR-A3, FR-S2, FR-S3, FR-S8): lock the cell,
 * PATCH with `base_version`, release the lock after a quiet period. Every call goes through
 * ShareClient, which refuses to send without the capability (default-deny). Edits to one cell are
 * serialized.
 *
 * `base_version` is pinned when an edit starts (the version the user saw). If the cell changed on
 * the server meanwhile, the PATCH answers 409 conflict instead of silently overwriting it.
 */

import { ShareClient, ShareHttpError } from "./client";
import { DocChange, DocCell, ShareDoc } from "./doc";

export interface EditorOptions {
  /** Wait after the last keystroke before sending. Default 800. */
  debounceMs?: number;
  /** Release the lock after this long without edits. Default 5000. */
  idleUnlockMs?: number;
  /** Delay before retrying a failed or refused save: base * 2^attempt. Default 2000. */
  retryBaseMs?: number;
  /** Retries of one pending edit before it waits for the next keystroke. Default 4. */
  maxRetries?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (h: unknown) => void;
}

export interface EditorHandlers {
  /** Korean message for the status line. */
  onError: (message: string) => void;
  /** Structure changes made by our own REST call (create, move, delete). */
  onChange: (c: DocChange) => void;
  /** Our own edit was saved: only the version changed, the editor DOM must stay as it is. */
  onSaved?: (cellId: string, version: number) => void;
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
  /** The version the user started editing from, per cell with an unsent edit. */
  private base = new Map<string, number>();
  private timers = new Map<string, unknown>();
  private idle = new Map<string, unknown>();
  private retryTimers = new Map<string, unknown>();
  private retries = new Map<string, number>();
  private locked = new Set<string>();
  private chain = new Map<string, Promise<void>>();
  private closed = false;

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
    if (this.closed || this.doc.indexOf(cellId) < 0) return;
    if (!this.pending.has(cellId)) {
      const v = this.doc.versionOf(cellId);
      if (v !== undefined) this.base.set(cellId, v); // pinned for the whole edit
    }
    this.pending.set(cellId, source);
    this.retries.delete(cellId);
    this.clear(this.retryTimers.get(cellId));
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

  private scheduleRetry(cellId: string) {
    const n = this.retries.get(cellId) ?? 0;
    if (n >= (this.o.maxRetries ?? 4) || this.closed) return;
    this.retries.set(cellId, n + 1);
    this.clear(this.retryTimers.get(cellId));
    this.retryTimers.set(
      cellId,
      this.set(() => void this.flush(cellId), (this.o.retryBaseMs ?? 2000) * 2 ** n)
    );
  }

  flush(cellId: string): Promise<void> {
    this.clear(this.timers.get(cellId));
    this.timers.delete(cellId);
    return this.enqueue(cellId, async () => {
      const source = this.pending.get(cellId);
      const base = this.base.get(cellId);
      if (source === undefined || base === undefined || this.closed) return;
      try {
        if (!this.locked.has(cellId)) {
          await this.client.lockCell(cellId);
          this.locked.add(cellId);
        }
        const cell = (await this.client.updateCell(cellId, { base_version: base, source })) as DocCell;
        this.retries.delete(cellId);
        if (this.pending.get(cellId) === source) {
          this.pending.delete(cellId);
          this.base.delete(cellId);
        } else {
          this.base.set(cellId, cell.version); // typed more while saving: the next PATCH builds on this one
        }
        if (cell) {
          this.doc.applyResult("updated", cell);
          this.h.onSaved?.(cellId, cell.version);
        }
        this.scheduleUnlock(cellId);
      } catch (e) {
        const http = e instanceof ShareHttpError ? e : undefined;
        if (http?.status === 409 && http.code === "locked") {
          // Someone else holds the lock: keep the edit and try again later.
          this.locked.delete(cellId);
          this.scheduleRetry(cellId);
        } else if (http?.status === 409) {
          // Stale base_version: the server's cell wins; free the lock we hold.
          this.pending.delete(cellId);
          this.base.delete(cellId);
          this.h.onConflict(cellId);
          void this.release(cellId);
        } else if (http?.status === 401 || http?.status === 403) {
          // Not retried: the share is gone or may not edit.
          this.pending.delete(cellId);
          this.base.delete(cellId);
          void this.release(cellId);
        } else {
          // Network failure or 5xx: keep the edit, retry, and do not leak the lock meanwhile.
          this.scheduleRetry(cellId);
          if (this.locked.has(cellId)) this.scheduleUnlock(cellId);
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

  /** Release the lock of a cell, unless an unsent edit still needs it. */
  release(cellId: string, keepalive = false): Promise<void> {
    this.clear(this.idle.get(cellId));
    this.idle.delete(cellId);
    return this.enqueue(cellId, async () => {
      if (!this.locked.has(cellId)) return;
      if (this.pending.has(cellId) && !this.closed) {
        this.scheduleUnlock(cellId);
        return;
      }
      this.locked.delete(cellId);
      try {
        await this.client.unlockCell(cellId, undefined, keepalive);
      } catch (e) {
        if (!this.closed) this.h.onError(editErrorMessage(e));
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

  /**
   * Send what is pending and release every lock (page hide, revoked share). With `keepalive` the
   * requests survive the page being closed: a locked cell is saved and unlocked in ONE request
   * (`DELETE .../lock` with the final source), the cheapest thing that can finish in time.
   * Errors are swallowed: nobody is left to read them.
   */
  async dispose(keepalive = false) {
    const ids = new Set([...this.pending.keys(), ...this.locked]);
    for (const t of [...this.timers.values(), ...this.idle.values(), ...this.retryTimers.values()]) this.clear(t);
    this.timers.clear();
    this.idle.clear();
    this.retryTimers.clear();
    await Promise.all(
      [...ids].map(async (id) => {
        const source = this.pending.get(id);
        const base = this.base.get(id);
        try {
          if (this.locked.has(id)) {
            this.locked.delete(id);
            await this.client.unlockCell(
              id,
              source !== undefined && base !== undefined ? { source, base_version: base } : undefined,
              keepalive
            );
          } else if (source !== undefined && base !== undefined) {
            await this.client.lockCell(id);
            await this.client.unlockCell(id, { source, base_version: base }, keepalive);
          }
        } catch {
          /* best effort */
        }
        this.pending.delete(id);
        this.base.delete(id);
      })
    );
    this.closed = true;
  }
}
