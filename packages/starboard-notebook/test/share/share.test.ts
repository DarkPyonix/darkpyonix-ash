import {
  abilitiesOf,
  isReadOnly,
  parseCapabilities,
  parseShareLink,
  stripTokenFromLocation,
  ShareClient,
  ShareHttpError,
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
    clientId: "ash-1",
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
    expect(init.headers["X-DarkPyonix-Client"]).toBe("ash-1");
  });
  it("test_fr_a3_verify_returns_the_capability_set", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, kernel_id: "k1", capabilities: ["read", "history"] }));
    const caps = await mkClient(f).verify();
    expect([...caps]).toEqual(["read", "history"]);
    expect(f.mock.calls[0][0]).toContain("/tokens/");
    expect(f.mock.calls[0][0]).toContain("/verify");
  });
  it("test_fr_a3_missing_capability_is_a_403_error", async () => {
    const f = jest.fn().mockResolvedValue(ok({ code: "forbidden" }, 403));
    await expect(mkClient(f).runs()).rejects.toMatchObject({ status: 403 });
    await expect(mkClient(f).lockCell("c1")).rejects.toBeInstanceOf(ShareHttpError);
  });
  it("test_fr_a3_error_message_never_contains_the_token", async () => {
    const f = jest.fn().mockResolvedValue(ok({}, 401));
    const e = await mkClient(f).document().catch((x) => x);
    expect(String(e.message)).not.toContain(TOKEN);
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
  onmessage: any;
  onclose: any;
  constructor(public url: string) {
    FakeWs.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
}

describe("FR-S9 WebSocket client", () => {
  it("test_fr_s9_ws_url_matches_the_api", () => {
    const c = mkClient(jest.fn(), FakeWs);
    expect(c.wsUrl()).toBe(`ws://127.0.0.1:8765/api/ws/kernels/k1?token=${TOKEN}&client_id=ash-1`);
  });
  it("test_fr_s9_ws_messages_and_replies", () => {
    const got: any[] = [];
    const s = mkClient(jest.fn(), FakeWs).openSocket((m) => got.push(m));
    s.requestHistory();
    s.startTyping("c1");
    expect(JSON.parse(FakeWs.last.sent[0])).toEqual({ type: "request_history", kernel_id: "k1" });
    expect(JSON.parse(FakeWs.last.sent[1])).toEqual({ type: "start_typing", cell_id: "c1", user_id: "ash-1" });
    FakeWs.last.onmessage({ data: JSON.stringify({ type: "error", error: "INSUFFICIENT_PERMISSION" }) });
    FakeWs.last.onmessage({ data: "garbage" });
    expect(got).toEqual([{ type: "error", error: "INSUFFICIENT_PERMISSION" }]);
  });
});
