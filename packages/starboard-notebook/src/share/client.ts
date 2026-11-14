/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share client: REST and WebSocket calls as in darkpyonix docs/api/manager.openapi.yaml and
 * PROTOCOL section 5. Errors and logs never contain the token (it is redacted from messages and
 * bodies, because the verify path and the WebSocket query carry it).
 *
 * Gating (default-deny): a call that needs a capability fails locally with `ShareForbiddenError`
 * and sends nothing unless the capability set is known (after `verify()` or from the options)
 * and holds it. The server remains the authority (INTENT D5, D18).
 */

import { Capability, parseCapabilities } from "./capabilities";

export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** A fresh client id matching the server rule `^[A-Za-z0-9_-]{8,64}$`. */
export function generateClientId(): string {
  const bytes = new Uint8Array(12);
  const c = (globalThis as any).crypto;
  // The id is a label, not a secret: fall back to Math.random where Web Crypto is missing.
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return "ash_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The error code of a server error body. The manager answers `{error: {code, message, data?}}`
 * (docs/api Error schema); a flat `{code}` is accepted too.
 */
export function errorCode(body: unknown): string | undefined {
  const b = body as any;
  const c = b?.error?.code ?? b?.code;
  return typeof c === "string" ? c : undefined;
}

export class ShareHttpError extends Error {
  /** Server error code, e.g. `token_revoked`, `forbidden`, `locked`, `conflict`. */
  code?: string;
  constructor(public status: number, public body: unknown) {
    super(`HTTP ${status}`);
    this.code = errorCode(body);
  }
}

/** Shown when the share was revoked (SPEC FR-A4, FR-A6). */
export const REVOKED_MESSAGE = "공유가 해지되었습니다";

/** 401 `token_revoked`, or a verify answer with `blacklisted: true`. */
export class TokenRevokedError extends ShareHttpError {
  constructor(body: unknown) {
    super(401, body);
    this.code = "token_revoked";
    this.message = REVOKED_MESSAGE;
  }
}

export class ShareNetworkError extends Error {}

export class ShareForbiddenError extends Error {
  constructor(public capability: Capability) {
    super(`missing capability: ${capability}`);
  }
}

export interface ShareClientOptions {
  managerUrl: string;
  kernelId: string;
  token: string;
  /** Must match ^[A-Za-z0-9_-]{8,64}$; defaults to a generated id. */
  clientId?: string;
  /**
   * Called once, the first time the share turns out to be revoked: a REST answer `401 token_revoked`
   * or a verify answer with `blacklisted: true`. From then on the client sends nothing.
   */
  onRevoked?: () => void;
  /** If known up front; otherwise set by `verify()`. */
  capabilities?: Iterable<Capability>;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
}

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

export interface SocketCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
  /** True if the socket never reached OPEN (upgrade refused: browsers hide 401/403/400). */
  neverOpened: boolean;
}

export interface SocketHandlers {
  onMessage: (m: WsMessage) => void;
  onOpen?: () => void;
  onError?: () => void;
  onClose?: (info: SocketCloseInfo) => void;
}

export class ShareClient {
  readonly clientId: string;
  private base: string;
  private fetchImpl: typeof fetch;
  private wsImpl?: typeof WebSocket;
  private caps?: Set<Capability>;

  constructor(private opts: ShareClientOptions) {
    this.clientId = opts.clientId ?? generateClientId();
    if (!CLIENT_ID_RE.test(this.clientId)) throw new Error("clientId must match ^[A-Za-z0-9_-]{8,64}$");
    this.base = `${opts.managerUrl.replace(/\/+$/, "")}/api/kernels/${encodeURIComponent(opts.kernelId)}`;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.wsImpl = opts.webSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
    if (opts.capabilities) this.caps = new Set(opts.capabilities);
  }

  get capabilities(): ReadonlySet<Capability> | undefined {
    return this.caps;
  }

  private _revoked = false;
  /** True once the server said the share is revoked; every later call fails locally. */
  get revoked(): boolean {
    return this._revoked;
  }
  private _shutdown = false;
  /** True once nothing may be sent any more: the share was revoked or the page ended it. */
  get blocked(): boolean {
    return this._revoked || this._shutdown;
  }
  /**
   * Stop all traffic (token no longer valid, connection lost, page ended the share). Later calls
   * fail locally without a request, like after a revocation.
   */
  shutdown() {
    this._shutdown = true;
  }
  private markRevoked() {
    if (this._revoked) return;
    this._revoked = true;
    this.opts.onRevoked?.();
  }
  /** Set or replace the revocation callback (the page wires it after connecting). */
  set onRevoked(fn: (() => void) | undefined) {
    this.opts.onRevoked = fn;
    if (fn && this._revoked) fn();
  }

  private redact(s: string): string {
    const t = this.opts.token;
    return t ? s.split(t).join("***").split(encodeURIComponent(t)).join("***") : s;
  }

  private redactBody(b: unknown): unknown {
    if (b === null || b === undefined) return b;
    try {
      return JSON.parse(this.redact(JSON.stringify(b)));
    } catch {
      return null;
    }
  }

  private need(c: Capability) {
    if (this.blocked) throw new TokenRevokedError(null);
    if (!this.caps || !this.caps.has(c)) throw new ShareForbiddenError(c);
  }

  private async call(method: string, path: string, body?: unknown, keepalive = false): Promise<any> {
    if (this.blocked) throw new TokenRevokedError(null); // nothing is sent for a revoked or ended share
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      "X-DarkPyonix-Client": this.clientId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let resp: Response;
    try {
      resp = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(keepalive ? { keepalive: true } : {}),
      });
    } catch (e) {
      throw new ShareNetworkError(this.redact(String((e as Error)?.message ?? e)));
    }
    let parsed: unknown = null;
    try {
      parsed = this.redactBody(await resp.json());
    } catch {
      /* empty body */
    }
    if (!resp.ok) {
      if (resp.status === 401 && errorCode(parsed) === "token_revoked") {
        this.markRevoked();
        throw new TokenRevokedError(parsed);
      }
      throw new ShareHttpError(resp.status, parsed);
    }
    return parsed;
  }

  /** GET /api/kernels/{id}/tokens/{token}/verify: the token's capability set (stored for gating). */
  async verify(): Promise<Set<Capability>> {
    const r = await this.call("GET", `/tokens/${encodeURIComponent(this.opts.token)}/verify`);
    if (r?.blacklisted === true) {
      this.markRevoked();
      throw new TokenRevokedError(r);
    }
    if (!r || r.valid !== true) throw new ShareHttpError(401, r);
    this.caps = parseCapabilities(r.capabilities);
    return new Set(this.caps);
  }

  /** GET .../document (needs read; outputs only with history). */
  document() {
    this.need("read");
    return this.call("GET", "/document");
  }
  /** GET .../runs (needs history). */
  runs() {
    this.need("history");
    return this.call("GET", "/runs");
  }
  /** POST .../runs (needs execute). */
  run(body: { mode: string; [k: string]: unknown }) {
    this.need("execute");
    return this.call("POST", "/runs", body);
  }
  /** POST .../interrupt (needs execute). */
  interrupt() {
    this.need("execute");
    return this.call("POST", "/interrupt");
  }
  /** POST .../cells (needs edit). `after`/`before` are cell ids; neither appends. */
  createCell(body: { source?: string; type?: string; after?: string; before?: string }) {
    this.need("edit");
    return this.call("POST", "/cells", body);
  }
  /** PATCH .../cells/{id} (needs edit; 409 conflict when `base_version` is stale, 409 locked). */
  updateCell(cellId: string, body: { base_version: number; source?: string; type?: string }) {
    this.need("edit");
    return this.call("PATCH", `/cells/${encodeURIComponent(cellId)}`, body);
  }
  /** DELETE .../cells/{id}?base_version= (needs edit). */
  deleteCell(cellId: string, baseVersion: number) {
    this.need("edit");
    return this.call("DELETE", `/cells/${encodeURIComponent(cellId)}?base_version=${baseVersion}`);
  }
  /** POST .../cells/{id}/move (needs edit); `toIndex` >= 1 (0 is the preamble). */
  moveCell(cellId: string, toIndex: number) {
    this.need("edit");
    return this.call("POST", `/cells/${encodeURIComponent(cellId)}/move`, { to_index: toIndex });
  }
  /** DELETE .../cells/{id}/lock (needs edit); optionally saves the final source. */
  unlockCell(cellId: string, final?: { source: string; base_version: number }, keepalive = false) {
    this.need("edit");
    return this.call("DELETE", `/cells/${encodeURIComponent(cellId)}/lock`, final, keepalive);
  }
  /** PUT .../cells/{id}/lock (needs edit). */
  lockCell(cellId: string) {
    this.need("edit");
    return this.call("PUT", `/cells/${encodeURIComponent(cellId)}/lock`);
  }

  /** WebSocket URL: /api/ws/kernels/{id}?token=&client_id= (FR-S9; the token is in the query by design). */
  wsUrl(): string {
    const u = new URL(this.opts.managerUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/ws/kernels/${encodeURIComponent(this.opts.kernelId)}`;
    u.search = new URLSearchParams({ token: this.opts.token, client_id: this.clientId }).toString();
    return u.toString();
  }

  /**
   * Open the sync socket. Call `verify()` first: a browser hides the upgrade status, so a refused
   * upgrade (401/403/400) only shows as close with `neverOpened: true`.
   */
  openSocket(h: SocketHandlers): ShareSocket {
    if (this.blocked) throw new TokenRevokedError(null); // never open a socket (its URL carries the token) for a dead share
    if (!this.wsImpl) throw new Error("WebSocket is not available");
    const ws = new this.wsImpl(this.wsUrl());
    const sock = new ShareSocket(
      ws,
      this.opts.kernelId,
      this.clientId,
      () => this.caps,
      () => this._revoked
    );
    ws.onopen = () => {
      sock.markOpen();
      h.onOpen?.();
    };
    ws.onerror = () => h.onError?.();
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m && typeof m.type === "string") h.onMessage(m);
      } catch {
        /* ignore non-JSON frames */
      }
    };
    ws.onclose = (ev: CloseEvent) =>
      h.onClose?.({
        code: ev?.code ?? 1006,
        reason: this.redact(ev?.reason ?? ""),
        wasClean: !!ev?.wasClean,
        neverOpened: !sock.opened,
      });
    return sock;
  }
}

export class ShareSocket {
  opened = false;
  private queue: string[] = [];
  constructor(
    private ws: WebSocket,
    private kernelId: string,
    private clientId: string,
    private caps: () => ReadonlySet<Capability> | undefined,
    private revoked: () => boolean = () => false
  ) {}

  markOpen() {
    this.opened = true;
    for (const s of this.queue.splice(0)) this.ws.send(s);
  }

  private need(c: Capability) {
    if (this.revoked()) throw new TokenRevokedError(null);
    const caps = this.caps();
    if (!caps || !caps.has(c)) throw new ShareForbiddenError(c);
  }

  /** Browsers throw on send before OPEN, so messages wait in a queue until it opens. */
  private send(m: WsMessage) {
    const s = JSON.stringify(m);
    if (this.opened) this.ws.send(s);
    else this.queue.push(s);
  }
  requestCode() {
    this.need("read");
    this.send({ type: "request_code", kernel_id: this.kernelId });
  }
  requestHistory() {
    this.need("history");
    this.send({ type: "request_history", kernel_id: this.kernelId });
  }
  requestLocks() {
    this.need("read");
    this.send({ type: "request_locks", kernel_id: this.kernelId });
  }
  startTyping(cellId: string) {
    this.need("edit");
    this.send({ type: "start_typing", cell_id: cellId, user_id: this.clientId });
  }
  cellFocus(cellId: string) {
    this.need("read");
    this.send({ type: "cell_focus", cell_id: cellId, user_id: this.clientId });
  }
  cellBlur(cellId: string) {
    this.need("read");
    this.send({ type: "cell_blur", cell_id: cellId });
  }
  close() {
    this.ws.close();
  }
}
