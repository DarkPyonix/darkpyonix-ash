import {
  abilitiesOf,
  isReadOnly,
  parseCapabilities,
  parseShareLink,
  stripTokenFromLocation,
  ShareClient,
  ShareHttpError,
  ShareForbiddenError,
  ShareNetworkError,
  TokenRevokedError,
  REVOKED_MESSAGE,
  FAILURE_MESSAGES,
  generateClientId,
  CLIENT_ID_RE,
} from "../../src/share";

const TOKEN = "tok-not-a-real-secret";
const SID = "s_0123456789abcdef";

describe("FR-A2 share link", () => {
  it("test_fr_a2_token_in_fragment", () => {
    const l = parseShareLink(`https://darkpyonix.dev/s/${SID}#${TOKEN}`);
    expect(l).toEqual({ token: TOKEN, shareId: SID });
  });
  it("test_fr_a2_token_in_query_is_accepted_on_share_links", () => {
    expect(parseShareLink(`https://x.test/s/${SID}?token=${TOKEN}`)?.token).toBe(TOKEN);
  });
  it("test_fr_a2_no_token_is_not_a_share_link", () => {
    expect(parseShareLink(`https://x.test/s/${SID}`)).toBeNull();
    expect(parseShareLink("not a url")).toBeNull();
  });
  it("test_fr_a2_plain_anchor_is_not_a_share_link", () => {
    expect(parseShareLink("https://x.test/index.html#anchor")).toBeNull();
    expect(parseShareLink("https://x.test/ash/#section-2")).toBeNull();
    expect(parseShareLink("https://x.test/ash/?manager=http://m:1#abc")).toBeNull();
    expect(parseShareLink("https://x.test/ash/#token=abc")?.token).toBe("abc");
  });
  it("test_fr_a2_direct_mode_reads_manager_and_kernel", () => {
    const l = parseShareLink(`https://x.test/ash/?manager=http://127.0.0.1:8765/&kernel=k_1#${TOKEN}`);
    expect(l).toMatchObject({ managerUrl: "http://127.0.0.1:8765", kernelId: "k_1", token: TOKEN });
  });
  it("test_fr_a2_token_is_stripped_from_the_address", () => {
    expect(stripTokenFromLocation(`https://x.test/s/${SID}?token=${TOKEN}#${TOKEN}`)).toBe(`https://x.test/s/${SID}`);
  });
});

describe("FR-A3 capabilities", () => {
  it("test_fr_a3_unknown_and_tier_names_are_dropped", () => {
    expect([...parseCapabilities(["read", "viewer2", "admin", "write", "edit"])].sort()).toEqual(["edit", "read"]);
    expect(parseCapabilities(undefined).size).toBe(0);
  });
  it("test_fr_a3_capabilities_have_no_order", () => {
    const a = abilitiesOf(parseCapabilities(["read", "edit"]));
    expect(a).toMatchObject({ canEdit: true, canExecute: false, canSeeOutputs: false });
    const b = abilitiesOf(parseCapabilities(["read", "execute"]));
    expect(b).toMatchObject({ canEdit: false, canExecute: true });
    expect(abilitiesOf(parseCapabilities(["manage"])).canRead).toBe(false);
  });
  it("test_fr_a3_read_only_means_neither_execute_nor_edit", () => {
    expect(isReadOnly(parseCapabilities(["read", "history"]))).toBe(true);
    expect(isReadOnly(parseCapabilities(["read", "edit"]))).toBe(false);
    expect(isReadOnly(parseCapabilities(["read", "execute"]))).toBe(false);
  });
});

function mkClient(fetchImpl: any, ws?: any) {
  return new ShareClient({
    managerUrl: "http://127.0.0.1:8765/",
    kernelId: "k1",
    token: TOKEN,
    clientId: "ash_test_01",
    capabilities: ["read", "history", "execute", "edit", "manage"],
    fetchImpl,
    webSocketImpl: ws,
  });
}
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("FR-A3 REST client", () => {
  it("test_fr_a3_requests_carry_bearer_and_client_header", async () => {
    const f = jest.fn().mockResolvedValue(ok({ cells: [] }));
    await mkClient(f).document();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8765/api/kernels/k1/document");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["X-DarkPyonix-Client"]).toBe("ash_test_01");
  });
  it("test_fr_a3_verify_returns_the_capability_set", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, kernel_id: "k1", capabilities: ["read", "history"] }));
    const caps = await mkClient(f).verify();
    expect([...caps]).toEqual(["read", "history"]);
    expect(f.mock.calls[0][0]).toContain("/tokens/");
    expect(f.mock.calls[0][0]).toContain("/verify");
  });
  it("test_fr_a3_missing_capability_is_a_403_error", async () => {
    const f = jest.fn().mockResolvedValue(ok({ error: { code: "forbidden", message: "x" } }, 403));
    await expect(mkClient(f).runs()).rejects.toMatchObject({ status: 403 });
    await expect(mkClient(f).lockCell("c1")).rejects.toBeInstanceOf(ShareHttpError);
  });
  it("test_fr_a3_network_error_and_body_never_contain_the_token", async () => {
    const f = jest.fn().mockRejectedValue(new Error(`failed to fetch http://m/tokens/${TOKEN}/verify`));
    const e = await mkClient(f)
      .verify()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ShareNetworkError);
    expect(String(e.message)).not.toContain(TOKEN);
    const g = jest
      .fn()
      .mockResolvedValue(ok({ error: { code: "bad_request", message: `no such token ${TOKEN}` } }, 400));
    const e2 = await mkClient(g)
      .document()
      .catch((x) => x);
    expect(JSON.stringify(e2.body)).not.toContain(TOKEN);
  });
  it("test_fr_a3_revoked_token_is_distinct_from_other_401", async () => {
    const f = jest.fn().mockResolvedValue(ok({ error: { code: "token_revoked", message: "x" } }, 401));
    await expect(mkClient(f).verify()).rejects.toBeInstanceOf(TokenRevokedError);
    const g = jest.fn().mockResolvedValue(ok({ error: { code: "unauthorized", message: "x" } }, 401));
    const e = await mkClient(g)
      .verify()
      .catch((x) => x);
    expect(e).toBeInstanceOf(ShareHttpError);
    expect(e).not.toBeInstanceOf(TokenRevokedError);
    expect(e.code).toBe("unauthorized");
  });
  it("test_fr_a3_verify_blacklisted_is_revoked", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, blacklisted: true, capabilities: ["read"] }));
    await expect(mkClient(f).verify()).rejects.toBeInstanceOf(TokenRevokedError);
  });
  it("test_fr_a3_client_does_not_send_what_the_capabilities_forbid", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, blacklisted: false, capabilities: ["read", "history"] }));
    const c = mkClient(f);
    await c.verify();
    f.mockClear();
    expect(() => c.run({ mode: "all" })).toThrow(ShareForbiddenError);
    expect(() => c.lockCell("c1")).toThrow(ShareForbiddenError);
    expect(f).not.toHaveBeenCalled();
    f.mockResolvedValue(ok({ cells: [] }));
    await c.document();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("test_fr_a3_client_id_follows_the_server_rule", () => {
    expect(CLIENT_ID_RE.test(generateClientId())).toBe(true);
    expect(() => new ShareClient({ managerUrl: "http://m", kernelId: "k", token: TOKEN, clientId: "ash-1" })).toThrow();
  });
  it("test_fr_a3_run_posts_mode_all", async () => {
    const f = jest.fn().mockResolvedValue(ok({}, 202));
    await mkClient(f).run({ mode: "all" });
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ mode: "all" });
  });
});

class FakeWs {
  static last: FakeWs;
  sent: string[] = [];
  onopen: any;
  onerror: any;
  onmessage: any;
  onclose: any;
  open = false;
  constructor(public url: string) {
    FakeWs.last = this;
  }
  send(s: string) {
    if (!this.open) throw new Error("InvalidStateError");
    this.sent.push(s);
  }
  close() {}
  doOpen() {
    this.open = true;
    this.onopen?.();
  }
}

const sockOpen = (caps?: string[]) => {
  const got: any[] = [];
  const closes: any[] = [];
  const c = new ShareClient({
    managerUrl: "http://127.0.0.1:8765/",
    kernelId: "k1",
    token: TOKEN,
    clientId: "ash_test_01",
    capabilities: (caps ?? ["read", "history", "execute", "edit", "manage"]) as any,
    fetchImpl: jest.fn(),
    webSocketImpl: FakeWs as any,
  });
  const s = c.openSocket({ onMessage: (m) => got.push(m), onClose: (i) => closes.push(i) });
  return { s, got, closes };
};

describe("FR-A3 default-deny", () => {
  const bare = (f: any) =>
    new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      fetchImpl: f,
      webSocketImpl: FakeWs as any,
    });
  it("test_fr_a3_unverified_client_sends_nothing", () => {
    const f = jest.fn();
    const c = bare(f);
    for (const fn of [
      () => c.document(),
      () => c.runs(),
      () => c.run({ mode: "all" }),
      () => c.interrupt(),
      () => c.createCell({}),
      () => c.updateCell("c1", { base_version: 1, source: "x" }),
      () => c.deleteCell("c1", 1),
      () => c.moveCell("c1", 2),
      () => c.lockCell("c1"),
      () => c.unlockCell("c1"),
    ]) {
      expect(fn).toThrow(ShareForbiddenError);
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("test_fr_a3_unverified_socket_sends_nothing", () => {
    const s = bare(jest.fn()).openSocket({ onMessage: () => undefined });
    FakeWs.last.doOpen();
    expect(() => s.requestCode()).toThrow(ShareForbiddenError);
    expect(() => s.startTyping("c1")).toThrow(ShareForbiddenError);
    expect(FakeWs.last.sent).toEqual([]);
  });
  it("test_fr_a3_execute_is_not_edit_and_edit_is_not_execute", async () => {
    const f = jest.fn().mockResolvedValue(ok({}));
    const ex = new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      capabilities: ["read", "execute"],
      fetchImpl: f,
    });
    const ed = new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      capabilities: ["read", "edit"],
      fetchImpl: f,
    });
    expect(() => ex.createCell({})).toThrow(ShareForbiddenError);
    expect(() => ex.lockCell("c")).toThrow(ShareForbiddenError);
    expect(() => ed.interrupt()).toThrow(ShareForbiddenError);
    expect(() => ed.run({ mode: "all" })).toThrow(ShareForbiddenError);
    expect(f).not.toHaveBeenCalled();
    await ex.interrupt();
    await ed.createCell({ source: "x" });
    expect(f.mock.calls.map((c: any) => [c[1].method, c[0].replace("http://m:1/api/kernels/k1", "")])).toEqual([
      ["POST", "/interrupt"],
      ["POST", "/cells"],
    ]);
  });
  it("test_fr_a3_edit_calls_use_the_documented_paths", async () => {
    const f = jest.fn().mockResolvedValue(ok({}));
    const c = new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      capabilities: ["edit"],
      fetchImpl: f,
    });
    await c.updateCell("c1", { base_version: 3, source: "y" });
    await c.deleteCell("c1", 4);
    await c.moveCell("c1", 0);
    await c.unlockCell("c1");
    expect(f.mock.calls.map((x: any) => [x[1].method, x[0].replace("http://m:1/api/kernels/k1", "")])).toEqual([
      ["PATCH", "/cells/c1"],
      ["DELETE", "/cells/c1?base_version=4"],
      ["POST", "/cells/c1/move"],
      ["DELETE", "/cells/c1/lock"],
    ]);
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ base_version: 3, source: "y" });
  });
});

describe("FR-S9 WebSocket client", () => {
  it("test_fr_s9_ws_url_matches_the_api", () => {
    expect(mkClient(jest.fn(), FakeWs).wsUrl()).toBe(
      `ws://127.0.0.1:8765/api/ws/kernels/k1?token=${TOKEN}&client_id=ash_test_01`
    );
  });
  it("test_fr_s9_ws_messages_and_replies", () => {
    const { s, got } = sockOpen();
    FakeWs.last.doOpen();
    s.requestHistory();
    s.startTyping("c1");
    expect(JSON.parse(FakeWs.last.sent[0])).toEqual({ type: "request_history", kernel_id: "k1" });
    expect(JSON.parse(FakeWs.last.sent[1])).toEqual({ type: "start_typing", cell_id: "c1", user_id: "ash_test_01" });
    FakeWs.last.onmessage({ data: JSON.stringify({ type: "error", error: "INSUFFICIENT_PERMISSION" }) });
    FakeWs.last.onmessage({ data: "garbage" });
    expect(got).toEqual([{ type: "error", error: "INSUFFICIENT_PERMISSION" }]);
  });
  it("test_fr_s9_send_before_open_is_queued_in_order", () => {
    const { s } = sockOpen();
    s.requestCode();
    s.requestLocks();
    expect(FakeWs.last.sent).toEqual([]);
    FakeWs.last.doOpen();
    expect(FakeWs.last.sent.map((x) => JSON.parse(x).type)).toEqual(["request_code", "request_locks"]);
  });
  it("test_fr_s9_refused_upgrade_is_reported_as_never_opened", () => {
    const { closes } = sockOpen();
    FakeWs.last.onclose({ code: 1006, reason: "", wasClean: false });
    expect(closes).toEqual([{ code: 1006, reason: "", wasClean: false, neverOpened: true }]);
  });
  it("test_fr_s9_close_after_open_carries_code_and_redacted_reason", () => {
    const { closes } = sockOpen();
    FakeWs.last.doOpen();
    FakeWs.last.onclose({ code: 1008, reason: `revoked ${TOKEN}`, wasClean: true });
    expect(closes[0]).toMatchObject({ code: 1008, neverOpened: false, wasClean: true });
    expect(closes[0].reason).not.toContain(TOKEN);
  });
  it("test_fr_s9_read_only_socket_does_not_send_start_typing", () => {
    const { s } = sockOpen(["read", "history"]);
    FakeWs.last.doOpen();
    expect(() => s.startTyping("c1")).toThrow(ShareForbiddenError);
    expect(FakeWs.last.sent).toEqual([]);
  });
});

describe("FR-A3 revoked share state", () => {
  const revokedBody = { error: { code: "token_revoked", message: "revoked" } };
  const all = ["read", "history", "execute", "edit", "manage"];
  const mk = (f: any, onRevoked?: () => void) =>
    new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      capabilities: all as any,
      fetchImpl: f,
      webSocketImpl: FakeWs as any,
      onRevoked,
    });
  const everyCall = (c: ShareClient): Array<() => Promise<unknown>> => [
    () => c.document(),
    () => c.runs(),
    () => c.run({ mode: "all" }),
    () => c.interrupt(),
    () => c.createCell({}),
    () => c.updateCell("c1", { base_version: 1, source: "x" }),
    () => c.deleteCell("c1", 1),
    () => c.moveCell("c1", 2),
    () => c.lockCell("c1"),
    () => c.unlockCell("c1"),
    () => c.verify(),
  ];

  it("test_fr_a3_message_is_korean_and_the_same_everywhere", () => {
    expect(REVOKED_MESSAGE).toBe("공유가 해지되었습니다");
    expect(FAILURE_MESSAGES.revoked).toBe(REVOKED_MESSAGE);
    expect(new TokenRevokedError(null).message).toBe(REVOKED_MESSAGE);
  });

  it("test_fr_a3_any_rest_401_token_revoked_marks_the_share_revoked_once", async () => {
    const f = jest.fn().mockResolvedValue(ok(revokedBody, 401));
    const seen = jest.fn();
    const c = mk(f, seen);
    await expect(c.interrupt()).rejects.toBeInstanceOf(TokenRevokedError);
    expect(c.revoked).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(() => c.document()).toThrow(TokenRevokedError); // blocked locally, synchronously
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("test_fr_a3_after_revocation_every_operation_is_blocked_without_a_request", async () => {
    const f = jest.fn().mockResolvedValue(ok(revokedBody, 401));
    const c = mk(f);
    await c.document().catch(() => undefined);
    f.mockClear();
    for (const call of everyCall(c)) {
      let thrown: unknown;
      try {
        await call();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(TokenRevokedError);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("test_fr_a3_verify_blacklisted_marks_the_share_revoked", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, blacklisted: true, capabilities: ["read"] }));
    const seen = jest.fn();
    const c = mk(f, seen);
    await expect(c.verify()).rejects.toBeInstanceOf(TokenRevokedError);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(c.revoked).toBe(true);
  });

  it("test_fr_a3_other_401_and_403_do_not_revoke", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [500, "internal"],
    ] as const) {
      const f = jest.fn().mockResolvedValue(ok({ error: { code, message: "x" } }, status));
      const seen = jest.fn();
      const c = mk(f, seen);
      await c.document().catch(() => undefined);
      expect(c.revoked).toBe(false);
      expect(seen).not.toHaveBeenCalled();
    }
  });

  it("test_fr_a3_revocation_blocks_the_socket_too", async () => {
    const f = jest.fn().mockResolvedValue(ok(revokedBody, 401));
    const c = mk(f);
    const s = c.openSocket({ onMessage: () => undefined });
    FakeWs.last.doOpen();
    await c.document().catch(() => undefined);
    expect(() => s.requestCode()).toThrow(TokenRevokedError);
    expect(() => s.startTyping("c1")).toThrow(TokenRevokedError);
    expect(FakeWs.last.sent).toEqual([]);
  });

  it("test_fr_a3_a_callback_set_after_revocation_still_fires", async () => {
    const f = jest.fn().mockResolvedValue(ok(revokedBody, 401));
    const c = mk(f);
    await c.document().catch(() => undefined);
    const late = jest.fn();
    c.onRevoked = late;
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("test_fr_a3_revoked_share_without_read_is_noticed_by_the_next_rest_call", async () => {
    const f = jest.fn().mockResolvedValue(ok(revokedBody, 401));
    const seen = jest.fn();
    const c = new ShareClient({
      managerUrl: "http://m:1",
      kernelId: "k1",
      token: TOKEN,
      capabilities: ["execute"],
      fetchImpl: f,
      onRevoked: seen,
    });
    await c.interrupt().catch(() => undefined);
    expect(seen).toHaveBeenCalledTimes(1); // no socket, no polling: the REST answer is enough
  });
});
