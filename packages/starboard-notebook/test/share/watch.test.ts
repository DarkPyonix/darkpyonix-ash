import { ShareClient, ShareWatch, outputsToElement, stripAnsi } from "../../src/share";

const TOKEN = "tok-not-a-real-secret";
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

class FakeWs {
  static all: FakeWs[] = [];
  sent: string[] = [];
  onopen: any;
  onerror: any;
  onmessage: any;
  onclose: any;
  open = false;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  doOpen() {
    this.open = true;
    this.onopen?.();
  }
}

function setup(verify: () => any) {
  FakeWs.all = [];
  const f = jest.fn(async () => verify());
  const client = new ShareClient({
    managerUrl: "http://m:1",
    kernelId: "k1",
    token: TOKEN,
    capabilities: ["read", "history"],
    fetchImpl: f as any,
    webSocketImpl: FakeWs as any,
  });
  const outs: Array<[string, unknown[]]> = [];
  const ends: string[] = [];
  const timers: Array<() => void> = [];
  const w = new ShareWatch(
    client,
    { onOutputs: (id, o) => outs.push([id, o]), onEnd: (e) => ends.push(e) },
    { setTimeoutImpl: (fn) => timers.push(fn) }
  );
  return { w, outs, ends, timers, f };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("FR-S9 live share", () => {
  it("test_fr_s9_history_data_fills_outputs_after_open", () => {
    const { w, outs } = setup(() => ok({}));
    w.start();
    FakeWs.all[0].doOpen();
    expect(JSON.parse(FakeWs.all[0].sent[0]).type).toBe("request_history");
    FakeWs.all[0].onmessage({
      data: JSON.stringify({
        type: "history_data",
        history: [{ cell_id: "c1", outputs: [{ output_type: "stream" }] }],
      }),
    });
    expect(outs).toEqual([["c1", [{ output_type: "stream" }]]]);
  });
  it("test_fr_s9_execution_events_accumulate_then_final_replaces", () => {
    const { w, outs } = setup(() => ok({}));
    w.onMessage({ type: "execution_started", cell_id: "c1" });
    w.onMessage({ type: "execution_output", cell_id: "c1", outputs: [{ output_type: "stream", text: "a" }] });
    w.onMessage({ type: "execution_output", cell_id: "c1", outputs: [{ output_type: "stream", text: "b" }] });
    expect((outs[outs.length - 1][1] as any[]).length).toBe(2);
    w.onMessage({ type: "execution_complete", cell_id: "c1", final_outputs: [{ output_type: "stream", text: "ab" }] });
    expect(outs[outs.length - 1][1]).toEqual([{ output_type: "stream", text: "ab" }]);
  });
  it("test_fr_s9_error_keeps_partial_outputs_and_adds_the_error", () => {
    const { w, outs } = setup(() => ok({}));
    w.onMessage({ type: "execution_output", cell_id: "c1", outputs: [{ output_type: "stream", text: "a" }] });
    w.onMessage({ type: "execution_error", cell_id: "c1", error: { ename: "E", evalue: "v", traceback: ["tb"] } });
    const last = outs[outs.length - 1][1] as any[];
    expect(last.map((o) => o.output_type)).toEqual(["stream", "error"]);
  });
});

describe("FR-A6 revoked share detection", () => {
  it("test_fr_a6_close_then_token_revoked_ends_the_watch", async () => {
    const { w, ends, timers } = setup(() => ok({ code: "token_revoked" }, 401));
    w.start();
    FakeWs.all[0].doOpen();
    FakeWs.all[0].onclose({ code: 1000, reason: "", wasClean: true });
    await flush();
    expect(ends).toEqual(["revoked"]);
    expect(timers).toEqual([]);
  });
  it("test_fr_a6_close_with_valid_token_reconnects_with_backoff", async () => {
    const { w, ends, timers } = setup(() => ok({ valid: true, blacklisted: false, capabilities: ["read"] }));
    w.start();
    FakeWs.all[0].doOpen();
    FakeWs.all[0].onclose({ code: 1006, reason: "", wasClean: false });
    await flush();
    expect(ends).toEqual([]);
    expect(timers.length).toBe(1);
    timers[0]();
    expect(FakeWs.all.length).toBe(2);
  });
  it("test_fr_a6_gives_up_after_retries_without_a_server", async () => {
    const { w, ends, timers } = setup(() => {
      throw new Error("down");
    });
    w.start();
    for (let i = 0; i < 6; i++) {
      FakeWs.all[FakeWs.all.length - 1].onclose({ code: 1006, reason: "", wasClean: false });
      await flush();
      timers.shift()?.();
    }
    expect(ends).toEqual(["lost"]);
  });
  it("test_fr_a6_stop_does_not_report_an_end", async () => {
    const { w, ends } = setup(() => ok({ code: "token_revoked" }, 401));
    w.start();
    w.stop();
    FakeWs.all[0].onclose({ code: 1000, reason: "", wasClean: true });
    await flush();
    expect(ends).toEqual([]);
  });
});

class El {
  children: El[] = [];
  className = "";
  textContent = "";
  src = "";
  constructor(public tag: string) {}
  append(...c: El[]) {
    this.children.push(...c);
  }
}
const fakeDoc: any = { createElement: (t: string) => new El(t) };

describe("FR-R4 output rendering", () => {
  it("test_fr_r4_stream_and_error_are_text_without_ansi", () => {
    const box: any = outputsToElement(fakeDoc, [
      { output_type: "stream", name: "stdout", text: ["a\n", "b"] },
      { output_type: "error", ename: "E", evalue: "v", traceback: ["\u001b[31mboom\u001b[0m"] },
    ]);
    expect(box.children.map((c: El) => c.textContent)).toEqual(["a\nb", "boom"]);
    expect(stripAnsi("\u001b[1mx\u001b[0m")).toBe("x");
  });
  it("test_fr_r4_html_output_is_never_injected", () => {
    const box: any = outputsToElement(fakeDoc, [
      { output_type: "display_data", data: { "text/html": "<script>alert(1)</script>", "text/plain": "plain" } },
      { output_type: "display_data", data: { "text/html": "<b>only html</b>" } },
    ]);
    expect(box.children.length).toBe(1);
    expect(box.children[0].textContent).toBe("plain");
  });
  it("test_fr_r4_png_becomes_a_data_url_image", () => {
    const box: any = outputsToElement(fakeDoc, [{ output_type: "display_data", data: { "image/png": "AAAA\n" } }]);
    expect(box.children[0].src).toBe("data:image/png;base64,AAAA");
  });
});
