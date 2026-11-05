import {
  END_MESSAGES,
  REVOKED_MESSAGE,
  ShareClient,
  ShareDoc,
  ShareEditor,
  ShareForbiddenError,
  ShareHttpError,
  ShareNetworkError,
  ShareWatch,
  createShareEnder,
  shareErrorMessage,
} from "../../src/share";

const TOKEN = "tok-not-a-real-secret";
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const revoked = ok({ error: { code: "token_revoked", message: "x" } }, 401);

class FakeWs {
  static all: FakeWs[] = [];
  onopen: any;
  onerror: any;
  onmessage: any;
  onclose: any;
  closed = false;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send() {}
  close() {
    this.closed = true;
  }
}

function parts(fetchImpl: any) {
  FakeWs.all = [];
  const client = new ShareClient({
    managerUrl: "http://m:1",
    kernelId: "k1",
    token: TOKEN,
    capabilities: ["read", "history", "edit", "execute"],
    fetchImpl,
    webSocketImpl: FakeWs as any,
  });
  const timers: Array<(() => void) & { cleared?: boolean; ms: number }> = [];
  const watch = new ShareWatch(
    client,
    { onOutputs: () => undefined, onEnd: () => undefined },
    {
      setTimeoutImpl: (fn, ms) => {
        const t = Object.assign(() => fn(), { ms }) as any;
        timers.push(t);
        return t;
      },
      clearTimeoutImpl: (t) => ((t as any).cleared = true),
      randomImpl: () => 0.5,
    }
  );
  const editor = new ShareEditor(client, new ShareDoc([{ cell_id: "a", type: "code", source: "x", version: 1 }]), {
    onError: jest.fn(),
    onChange: jest.fn(),
    onConflict: jest.fn(),
  });
  const status: Array<[string, boolean]> = [];
  const block = jest.fn();
  const end = createShareEnder({
    client,
    watch: () => watch,
    editor: () => editor,
    blockControls: block,
    showStatus: (t, e) => status.push([t, e]),
  });
  return { client, watch, editor, status, block, end, timers };
}

describe("FR-A6 ending a share page", () => {
  it("test_fr_a6_end_runs_once_and_shows_one_message", () => {
    const { end, status, block } = parts(jest.fn());
    end("revoked");
    end("lost");
    end("revoked");
    expect(status).toEqual([[REVOKED_MESSAGE, true]]);
    expect(block).toHaveBeenCalledTimes(1);
  });

  it("test_fr_a6_end_stops_the_watch_and_closes_the_socket", () => {
    const { end, watch } = parts(jest.fn());
    watch.start();
    expect(FakeWs.all.length).toBe(1);
    end("revoked");
    expect(FakeWs.all[0].closed).toBe(true);
  });

  it("test_fr_a6_rest_revocation_stops_a_pending_reconnect_from_opening_a_socket", async () => {
    const f = jest.fn().mockResolvedValue(ok({ valid: true, blacklisted: false, capabilities: ["read"] }));
    const { client, watch, end, timers } = parts(f);
    client.onRevoked = () => end("revoked");
    watch.start();
    FakeWs.all[0].onclose({ code: 1006, reason: "", wasClean: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.filter((t) => !t.cleared).length).toBe(1); // a reconnect is waiting
    f.mockResolvedValue(revoked);
    await client.document().catch(() => undefined); // a REST call learns the share is revoked
    expect(timers[0].cleared).toBe(true);
    timers[0](); // even if the timer fired anyway
    expect(FakeWs.all.length).toBe(1); // no new WebSocket (its URL would carry the token)
  });

  it("test_fr_a6_watch_start_on_a_blocked_client_opens_nothing_and_ends", () => {
    const { client, watch } = parts(jest.fn());
    const ends: string[] = [];
    (watch as any).h.onEnd = (e: string) => ends.push(e);
    client.shutdown();
    watch.start();
    expect(FakeWs.all.length).toBe(0);
    expect(ends).toEqual(["lost"]);
  });

  it("test_fr_a6_unauthorized_and_lost_also_shut_the_client_and_dispose_sends_nothing", async () => {
    for (const why of ["unauthorized", "lost"] as const) {
      const f = jest.fn().mockResolvedValue(ok({}));
      const { client, editor, end, status } = parts(f);
      editor.localChange("a", "pending text");
      end(why);
      await editor.dispose(false);
      expect(client.blocked).toBe(true);
      expect(client.revoked).toBe(false);
      expect(f).not.toHaveBeenCalled(); // no lock/unlock/save with a dead token
      expect(status).toEqual([[END_MESSAGES[why], true]]);
    }
  });

  it("test_fr_a6_end_disposes_the_editor_silently", async () => {
    const f = jest.fn().mockResolvedValue(ok({}));
    const errors: string[] = [];
    const { client, end } = parts(f);
    const editor = new ShareEditor(client, new ShareDoc([{ cell_id: "a", type: "code", source: "x", version: 1 }]), {
      onError: (m) => errors.push(m),
      onChange: jest.fn(),
      onConflict: jest.fn(),
    });
    const ender = createShareEnder({
      client,
      watch: () => undefined,
      editor: () => editor,
      blockControls: jest.fn(),
      showStatus: jest.fn(),
    });
    editor.localChange("a", "x2");
    ender("revoked");
    await editor.dispose();
    expect(errors).toEqual([]);
    expect(end).toBeDefined();
  });
});

describe("FR-A3 error messages", () => {
  it("test_fr_a3_generic_401_has_its_own_korean_message", () => {
    expect(shareErrorMessage(new ShareHttpError(401, { error: { code: "unauthorized", message: "x" } }))).toBe(
      "인증에 실패했습니다"
    );
    expect(shareErrorMessage(new ShareHttpError(403, null))).toContain("권한");
    expect(shareErrorMessage(new ShareForbiddenError("edit"))).toContain("권한");
    expect(shareErrorMessage(new ShareHttpError(409, { error: { code: "busy", message: "x" } }))).toContain("실행");
    expect(shareErrorMessage(new ShareNetworkError("x"))).toContain("매니저");
    expect(shareErrorMessage(new Error(`boom ${TOKEN}`))).not.toContain(TOKEN);
  });
});
