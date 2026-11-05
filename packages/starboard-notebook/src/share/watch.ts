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
  baseDelayMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
}

export class ShareWatch {
  private socket?: ShareSocket;
  private stopped = false;
  private retries = 0;
  private partial = new Map<string, unknown[]>();

  constructor(private client: ShareClient, private h: WatchHandlers, private o: WatchOptions = {}) {}

  start() {
    this.h.onState?.(this.retries ? "reconnecting" : "connecting");
    this.socket = this.client.openSocket({
      onOpen: () => {
        this.retries = 0;
        this.h.onState?.("live");
        if (this.client.capabilities?.has("history")) this.socket?.requestHistory();
      },
      onMessage: (m) => this.onMessage(m),
      onClose: (info) => void this.onClose(info),
    });
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
  }

  private end(why: WatchEnd) {
    this.stopped = true;
    this.h.onEnd(why);
  }

  private async onClose(_info: SocketCloseInfo) {
    if (this.stopped) return;
    try {
      await this.client.verify();
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof TokenRevokedError) return this.end("revoked");
      if (e instanceof ShareHttpError && (e.status === 401 || e.status === 403)) return this.end("unauthorized");
      // network failure or 5xx: fall through to retry
    }
    if (this.stopped) return;
    const max = this.o.maxRetries ?? 5;
    if (this.retries >= max) return this.end("lost");
    const delay = (this.o.baseDelayMs ?? 1000) * 2 ** this.retries++;
    (this.o.setTimeoutImpl ?? setTimeout)(() => !this.stopped && this.start(), delay);
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
