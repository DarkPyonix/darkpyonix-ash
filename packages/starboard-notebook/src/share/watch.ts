/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live view of a share (SPEC FR-S9, FR-A5/A6): opens the sync socket, turns its messages into
 * per-cell output updates, and detects revocation. A kernel closes the streams of a revoked share
 * (`streams.close`), so a close is followed by `verify()`: a revoked token ends the watch, a
 * network failure is retried with backoff.
 */

import { ShareClient, ShareSocket, SocketCloseInfo, TokenRevokedError, WsMessage, ShareHttpError } from "./client";

export type WatchEnd = "revoked" | "unauthorized" | "lost";

export interface WatchHandlers {
  /** Replace the outputs shown under a cell. */
  onOutputs: (cellId: string, outputs: unknown[]) => void;
  onEnd: (why: WatchEnd) => void;
  /** Connection state for the banner. */
  onState?: (s: "connecting" | "live" | "reconnecting") => void;
}

export interface WatchOptions {
  maxRetries?: number;
  /** Base delay; attempt n waits base * 2^n, then jitter. Default 1000 (1, 2, 4, 8, 16 s). */
  baseDelayMs?: number;
  /** Fraction of the delay added or removed at random. Default 0.3. */
  jitter?: number;
  /** A socket that stayed open this long counts as healthy and resets the retry count. Default 10000. */
  stableMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  randomImpl?: () => number;
  nowImpl?: () => number;
}

export class ShareWatch {
  private socket?: ShareSocket;
  private stopped = false;
  private retries = 0;
  private generation = 0;
  private openedAt: number | undefined;
  private gotMessage = false;
  private timer: unknown;
  private partial = new Map<string, unknown[]>();

  constructor(private client: ShareClient, private h: WatchHandlers, private o: WatchOptions = {}) {}

  private now() {
    return (this.o.nowImpl ?? Date.now)();
  }

  /** Delay before reconnect attempt `n` (0-based): exponential with random jitter. */
  delayFor(n: number): number {
    const base = (this.o.baseDelayMs ?? 1000) * 2 ** n;
    const j = this.o.jitter ?? 0.3;
    const r = (this.o.randomImpl ?? Math.random)();
    return Math.max(0, Math.round(base * (1 + (r * 2 - 1) * j)));
  }

  start() {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.gotMessage = false;
    this.h.onState?.(this.retries ? "reconnecting" : "connecting");
    this.socket = this.client.openSocket({
      onOpen: () => {
        if (gen !== this.generation) return;
        // Not reset here: a socket that opens and closes at once must not restart the backoff.
        this.openedAt = this.now();
        this.h.onState?.("live");
        if (this.client.capabilities?.has("history")) this.socket?.requestHistory();
      },
      onMessage: (m) => {
        if (gen !== this.generation) return;
        this.gotMessage = true;
        this.retries = 0;
        this.onMessage(m);
      },
      onClose: (info) => {
        if (gen !== this.generation) return;
        this.generation++; // a second close event for the same socket is ignored
        void this.onClose(info);
      },
    });
  }

  stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer !== undefined) (this.o.clearTimeoutImpl ?? clearTimeout)(this.timer as any);
    this.timer = undefined;
    this.socket?.close();
  }

  private end(why: WatchEnd) {
    this.stopped = true;
    this.h.onEnd(why);
  }

  private async onClose(_info: SocketCloseInfo) {
    if (this.stopped) return;
    if (this.openedAt !== undefined && this.now() - this.openedAt >= (this.o.stableMs ?? 10000)) this.retries = 0;
    this.openedAt = undefined;
    try {
      await this.client.verify();
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof TokenRevokedError) return this.end("revoked");
      if (e instanceof ShareHttpError && (e.status === 401 || e.status === 403)) return this.end("unauthorized");
      // network failure or 5xx: fall through to retry
    }
    if (this.stopped) return;
    if (this.retries >= (this.o.maxRetries ?? 5)) return this.end("lost");
    const delay = this.delayFor(this.retries++);
    this.timer = (this.o.setTimeoutImpl ?? setTimeout)(() => {
      this.timer = undefined;
      this.start();
    }, delay);
  }

  onMessage(m: WsMessage) {
    const cellId = typeof m.cell_id === "string" ? m.cell_id : undefined;
    switch (m.type) {
      case "history_data":
        for (const e of (m.history as any[]) ?? []) {
          if (e && typeof e.cell_id === "string") this.h.onOutputs(e.cell_id, e.outputs ?? []);
        }
        break;
      case "execution_started":
        if (cellId) {
          this.partial.set(cellId, []);
          this.h.onOutputs(cellId, []);
        }
        break;
      case "execution_output":
        if (cellId) {
          const acc = [...(this.partial.get(cellId) ?? []), ...(((m.outputs as any[]) ?? []) as unknown[])];
          this.partial.set(cellId, acc);
          this.h.onOutputs(cellId, acc);
        }
        break;
      case "execution_complete":
        if (cellId && Array.isArray(m.final_outputs)) this.h.onOutputs(cellId, m.final_outputs);
        if (cellId) this.partial.delete(cellId);
        break;
      case "execution_error":
        if (cellId) {
          const err = m.error as any;
          this.h.onOutputs(cellId, [
            ...(this.partial.get(cellId) ?? []),
            { output_type: "error", ename: err?.ename, evalue: err?.evalue, traceback: err?.traceback ?? [] },
          ]);
          this.partial.delete(cellId);
        }
        break;
      case "execution_interrupted":
        if (cellId && Array.isArray(m.partial_outputs)) this.h.onOutputs(cellId, m.partial_outputs);
        if (cellId) this.partial.delete(cellId);
        break;
    }
  }
}
