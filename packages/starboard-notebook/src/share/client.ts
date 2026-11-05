/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share client: REST and WebSocket calls exactly as in darkpyonix docs/api/manager.openapi.yaml
 * and PROTOCOL section 5. Never logs or stringifies the token.
 */

import { Capability, parseCapabilities } from "./capabilities";

export class ShareHttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}`);
  }
}

export interface ShareClientOptions {
  managerUrl: string;
  kernelId: string;
  token: string;
  /** Sent as X-DarkPyonix-Client and as `client_id` on the WebSocket. */
  clientId: string;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
}

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

export class ShareClient {
  private base: string;
  private fetchImpl: typeof fetch;
  private wsImpl?: typeof WebSocket;

  constructor(private opts: ShareClientOptions) {
    this.base = `${opts.managerUrl.replace(/\/+$/, "")}/api/kernels/${encodeURIComponent(opts.kernelId)}`;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.wsImpl = opts.webSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  }

  async call(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      "X-DarkPyonix-Client": this.opts.clientId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await resp.json();
    } catch {
      /* empty body */
    }
    if (!resp.ok) throw new ShareHttpError(resp.status, parsed);
    return parsed;
  }

  /** GET /api/kernels/{id}/tokens/{token}/verify: the token's capability set. */
  async verify(): Promise<Set<Capability>> {
    const r = await this.call("GET", `/tokens/${encodeURIComponent(this.opts.token)}/verify`);
    if (!r || r.valid === false) throw new ShareHttpError(401, r);
    return parseCapabilities(r.capabilities);
  }

  /** GET .../document (needs read; outputs only with history). */
  document() {
    return this.call("GET", "/document");
  }
  /** GET .../runs (needs history). */
  runs() {
    return this.call("GET", "/runs");
  }
  /** POST .../runs (needs execute). */
  run(body: { mode: string; [k: string]: unknown }) {
    return this.call("POST", "/runs", body);
  }
  /** PUT .../cells/{id}/lock (needs edit). */
  lockCell(cellId: string) {
    return this.call("PUT", `/cells/${encodeURIComponent(cellId)}/lock`);
  }

  /** WebSocket URL, as in the real-stack test: /api/ws/kernels/{id}?token=&client_id= (FR-S9). */
  wsUrl(): string {
    const u = new URL(this.opts.managerUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/ws/kernels/${encodeURIComponent(this.opts.kernelId)}`;
    u.search = new URLSearchParams({ token: this.opts.token, client_id: this.opts.clientId }).toString();
    return u.toString();
  }

  /** Open the sync socket; `onMessage` gets each parsed JSON message. */
  openSocket(onMessage: (m: WsMessage) => void, onClose?: () => void): ShareSocket {
    if (!this.wsImpl) throw new Error("WebSocket is not available");
    const ws = new this.wsImpl(this.wsUrl());
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m && typeof m.type === "string") onMessage(m);
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.onclose = () => onClose?.();
    return new ShareSocket(ws, this.opts.kernelId, this.opts.clientId);
  }
}

export class ShareSocket {
  constructor(private ws: WebSocket, private kernelId: string, private clientId: string) {}
  private send(m: WsMessage) {
    this.ws.send(JSON.stringify(m));
  }
  requestCode() {
    this.send({ type: "request_code", kernel_id: this.kernelId });
  }
  requestHistory() {
    this.send({ type: "request_history", kernel_id: this.kernelId });
  }
  requestLocks() {
    this.send({ type: "request_locks", kernel_id: this.kernelId });
  }
  startTyping(cellId: string) {
    this.send({ type: "start_typing", cell_id: cellId, user_id: this.clientId });
  }
  cellFocus(cellId: string) {
    this.send({ type: "cell_focus", cell_id: cellId, user_id: this.clientId });
  }
  cellBlur(cellId: string) {
    this.send({ type: "cell_blur", cell_id: cellId });
  }
  close() {
    this.ws.close();
  }
}
