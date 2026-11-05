import {
  errorCode,
  ShareClient,
  ShareDoc,
  ShareEditor,
  ShareHttpError,
  connectShare,
  gateControls,
} from "../../src/share";

const TOKEN = "tok-not-a-real-secret";
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const cell = (id: string, version = 1, source = "x\n", index = 0) => ({
  cell_id: id,
  type: "code",
  source,
  version,
  index,
});

describe("FR-S2 document model", () => {
  it("test_fr_s2_events_create_update_move_delete_in_order", () => {
    const d = new ShareDoc([cell("a", 1, "", 0), cell("b", 1, "", 1)]);
    expect(d.apply("doc.cell.created", { cell: cell("c", 1, "", 1) })).toMatchObject({ kind: "created", index: 1 });
    expect(d.cells.map((c) => c.cell_id)).toEqual(["a", "c", "b"]);
    expect(d.apply("doc.cell.updated", { cell: cell("c", 2, "new") })).toMatchObject({ kind: "updated" });
    expect(d.apply("doc.cell.moved", { cell: cell("c", 3, "new", 2) })).toMatchObject({
      kind: "moved",
      from: 1,
      index: 2,
    });
    expect(d.cells.map((c) => c.cell_id)).toEqual(["a", "b", "c"]);
    expect(d.apply("doc.cell.deleted", { cell_id: "a" })).toMatchObject({ kind: "deleted", index: 0 });
    expect(d.cells.map((c) => c.cell_id)).toEqual(["b", "c"]);
  });
  it("test_fr_s2_already_applied_events_are_ignored", () => {
    const d = new ShareDoc([cell("a", 2)]);
    expect(d.apply("doc.cell.updated", { cell: cell("a", 2) })).toBeNull();
    expect(d.apply("doc.cell.updated", { cell: cell("a", 1) })).toBeNull();
    expect(d.apply("doc.cell.created", { cell: cell("a", 5) })).toBeNull();
    expect(d.apply("doc.cell.deleted", { cell_id: "zzz" })).toBeNull();
    expect(d.apply("doc.lock", { cell_id: "a" })).toBeNull();
  });
  it("test_fr_s2_reload_replaces_everything", () => {
    const d = new ShareDoc([cell("a")]);
    expect(d.apply("doc.reloaded", { cells: [cell("x"), cell("y")] })).toMatchObject({ kind: "reloaded" });
    expect(d.cells.map((c) => c.cell_id)).toEqual(["x", "y"]);
  });
});

type Timer = (() => void) & { ms: number; cleared?: boolean };
function setupEditor(responses: (method: string, url: string, body: any) => any, caps: string[] = ["read", "edit"]) {
  const calls: Array<[string, string, any]> = [];
  const inits: any[] = [];
  const f = jest.fn(async (url: string, init: any) => {
    const u = url.replace("http://m:1/api/kernels/k1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method, u, body]);
    inits.push(init);
    return responses(init.method, u, body);
  });
  const client = new ShareClient({
    managerUrl: "http://m:1",
    kernelId: "k1",
    token: TOKEN,
    capabilities: caps as any,
    fetchImpl: f as any,
  });
  const doc = new ShareDoc([cell("a", 1, "old\n", 0)]);
  const errors: string[] = [];
  const changes: any[] = [];
  const conflicts: string[] = [];
  const timers: Timer[] = [];
  const saved: Array<[string, number]> = [];
  const editor = new ShareEditor(
    client,
    doc,
    {
      onError: (m) => errors.push(m),
      onChange: (c) => changes.push(c),
      onSaved: (id, v) => saved.push([id, v]),
      onConflict: (id) => conflicts.push(id),
    },
    {
      setTimeoutImpl: (fn, ms) => {
        const t: Timer = Object.assign(() => fn(), { ms });
        timers.push(t);
        return t;
      },
      clearTimeoutImpl: (t) => ((t as Timer).cleared = true),
    }
  );
  return { editor, doc, calls, errors, changes, conflicts, timers, inits, saved };
}

describe("FR-S3 cell editing", () => {
  it("test_fr_s3_edit_locks_then_patches_with_base_version", async () => {
    const { editor, doc, calls, changes } = setupEditor((m, u) =>
      m === "PATCH" ? ok(cell("a", 2, "new\n")) : ok({ cell_id: "a" })
    );
    editor.localChange("a", "new\n");
    await editor.flush("a");
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ["PUT", "/cells/a/lock"],
      ["PATCH", "/cells/a"],
    ]);
    expect(calls[1][2]).toEqual({ base_version: 1, source: "new\n" });
    expect(doc.versionOf("a")).toBe(2);
    expect(changes.length).toBe(0); // an own save is not a DOM change (see onSaved)
  });
  it("test_fr_s3_debounce_sends_one_patch_for_many_keystrokes", async () => {
    const { editor, timers, calls } = setupEditor((m) => (m === "PATCH" ? ok(cell("a", 2, "abc")) : ok({})));
    editor.localChange("a", "a");
    editor.localChange("a", "ab");
    editor.localChange("a", "abc");
    expect(timers.filter((t) => !t.cleared).length).toBe(1);
    expect(timers[0].ms).toBe(800);
    await editor.flush("a");
    expect(calls.filter((c) => c[0] === "PATCH").length).toBe(1);
    expect(calls[1][2].source).toBe("abc");
  });
  it("test_fr_s3_lock_is_released_after_a_quiet_period", async () => {
    const { editor, timers, calls } = setupEditor((m) => (m === "PATCH" ? ok(cell("a", 2)) : ok({})));
    editor.localChange("a", "z");
    await editor.flush("a");
    const idle = timers[timers.length - 1];
    expect(idle.ms).toBe(5000);
    idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[calls.length - 1].slice(0, 2)).toEqual(["DELETE", "/cells/a/lock"]);
  });
  it("test_fr_s3_locked_by_someone_else_reports_and_does_not_patch", async () => {
    const { editor, calls, errors } = setupEditor((m) =>
      m === "PUT" ? ok({ error: { code: "locked", message: "x" } }, 409) : ok({})
    );
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(calls.map((c) => c[0])).toEqual(["PUT"]);
    expect(errors).toEqual(["다른 사용자가 수정 중인 셀입니다"]);
  });
  it("test_fr_s3_stale_version_is_a_conflict_and_drops_the_edit", async () => {
    const { editor, errors, conflicts } = setupEditor((m) =>
      m === "PATCH" ? ok({ error: { code: "conflict", message: "x" } }, 409) : ok({})
    );
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(conflicts).toEqual(["a"]);
    expect(editor.hasPending("a")).toBe(false);
    expect(errors[0]).toContain("먼저 수정");
  });
  it("test_fr_s8_read_only_token_never_reaches_the_network", async () => {
    const { editor, calls, errors } = setupEditor(() => ok({}), ["read", "history", "execute"]);
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(await editor.insert({ source: "x" })).toBe(false);
    expect(await editor.remove("a")).toBe(false);
    expect(await editor.move("a", 2)).toBe(false);
    expect(calls).toEqual([]);
    expect(errors.length).toBe(4);
  });
  it("test_fr_s2_insert_remove_move_follow_the_answer", async () => {
    const { editor, doc, calls } = setupEditor((m, u) =>
      m === "POST" && u === "/cells"
        ? ok(cell("n", 1, "", 1), 201)
        : m === "POST"
        ? ok(cell("n", 2, "", 1))
        : ok({}, 204)
    );
    expect(await editor.insert({ after: "a", source: "" })).toBe("n");
    expect(doc.cells.map((c) => c.cell_id)).toEqual(["a", "n"]);
    expect(await editor.move("n", 0)).toBe(true);
    expect(calls[1][2]).toEqual({ to_index: 1 }); // index 0 is the preamble: clamped to 1
    expect(await editor.remove("n")).toBe(true);
    expect(calls[2][1]).toBe("/cells/n?base_version=2");
    expect(doc.cells.map((c) => c.cell_id)).toEqual(["a"]);
  });
});

describe("FR-A3 server error shape", () => {
  it("test_fr_a3_error_code_reads_the_server_error_body", () => {
    expect(errorCode({ error: { code: "locked", message: "m", data: {} } })).toBe("locked");
    expect(errorCode({ code: "conflict" })).toBe("conflict");
    expect(errorCode({ error: "x" })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe("FR-S3 edit safety", () => {
  const flushAll = () => new Promise((r) => setTimeout(r, 0));

  it("test_fr_s3_base_version_is_pinned_when_the_edit_starts", async () => {
    const { editor, doc, calls } = setupEditor((m) =>
      m === "PATCH" ? ok({ error: { code: "conflict", message: "x" } }, 409) : ok({})
    );
    editor.localChange("a", "mine\n"); // the user saw version 1
    doc.apply("doc.cell.updated", { cell: cell("a", 2, "theirs\n") }); // a remote edit arrives while debouncing
    await editor.flush("a");
    const patch = calls.find((c) => c[0] === "PATCH")!;
    expect(patch[2].base_version).toBe(1); // not 2: the server must refuse, not be overwritten
  });
  it("test_fr_s3_remote_edit_while_pending_ends_in_a_conflict_not_an_overwrite", async () => {
    const { editor, doc, conflicts, errors } = setupEditor((m) =>
      m === "PATCH" ? ok({ error: { code: "conflict", message: "x" } }, 409) : ok({})
    );
    editor.localChange("a", "mine\n");
    doc.apply("doc.cell.updated", { cell: cell("a", 2, "theirs\n") });
    await editor.flush("a");
    expect(conflicts).toEqual(["a"]);
    expect(errors[0]).toContain("먼저 수정");
  });
  it("test_fr_s3_conflict_releases_the_lock", async () => {
    const { editor, calls } = setupEditor((m) =>
      m === "PATCH" ? ok({ error: { code: "conflict", message: "x" } }, 409) : ok({})
    );
    editor.localChange("a", "z");
    await editor.flush("a");
    await flushAll();
    expect(calls.map((c) => c[0] + " " + c[1])).toContain("DELETE /cells/a/lock");
  });
  it("test_fr_s3_locked_by_someone_else_keeps_the_edit_and_retries", async () => {
    let locked = true;
    const { editor, timers, calls, conflicts } = setupEditor((m) =>
      m === "PUT" && locked
        ? ok({ error: { code: "locked", message: "x" } }, 409)
        : m === "PATCH"
        ? ok(cell("a", 2, "z"))
        : ok({})
    );
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(editor.hasPending("a")).toBe(true);
    expect(conflicts).toEqual([]);
    const retry = timers[timers.length - 1];
    expect(retry.ms).toBe(2000);
    locked = false;
    retry();
    await flushAll();
    expect(calls.filter((c) => c[0] === "PATCH").length).toBe(1);
    expect(editor.hasPending("a")).toBe(false);
  });
  it("test_fr_s3_network_failure_retries_and_does_not_leak_the_lock", async () => {
    let down = true;
    const { editor, timers, calls } = setupEditor((m) => {
      if (m === "PATCH" && down) throw new Error("network");
      return m === "PATCH" ? ok(cell("a", 2, "z")) : ok({});
    });
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(editor.hasPending("a")).toBe(true);
    const pendingTimers = timers.filter((t) => !t.cleared).map((t) => t.ms);
    expect(pendingTimers).toContain(2000); // retry
    expect(pendingTimers).toContain(5000); // idle unlock, so the lock cannot leak
    down = false;
    timers.filter((t) => t.ms === 2000)[0]();
    await flushAll();
    expect(calls.filter((c) => c[0] === "PATCH").length).toBe(2);
    expect(editor.hasPending("a")).toBe(false);
  });
  it("test_fr_s3_retries_stop_after_the_limit", async () => {
    const { editor, timers } = setupEditor((m) => {
      if (m === "PATCH") throw new Error("network");
      return ok({});
    });
    editor.localChange("a", "z");
    for (let i = 0; i < 8; i++) {
      await editor.flush("a");
      const t = timers.filter((x) => !x.cleared && x.ms >= 2000 && x.ms !== 5000).pop();
      if (t) t.cleared = true;
    }
    expect(timers.filter((t) => t.ms >= 2000 && t.ms !== 5000).length).toBe(4);
  });
  it("test_fr_s3_double_flush_sends_one_patch", async () => {
    const { editor, calls } = setupEditor((m) => (m === "PATCH" ? ok(cell("a", 2, "z")) : ok({})));
    editor.localChange("a", "z");
    await Promise.all([editor.flush("a"), editor.flush("a")]);
    expect(calls.filter((c) => c[0] === "PATCH").length).toBe(1);
    expect(calls.filter((c) => c[0] === "PUT").length).toBe(1);
  });
  it("test_fr_s3_typing_while_saving_builds_on_the_saved_version", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const { editor, calls } = setupEditor(async (m, u, b) => {
      if (m !== "PATCH") return ok({});
      if (n++ === 0) await gate; // the first PATCH stays in flight
      return ok(cell("a", n === 1 ? 2 : 3, b.source));
    });
    editor.localChange("a", "z1");
    const first = editor.flush("a");
    await flushAll(); // the first PATCH is now on the wire
    editor.localChange("a", "z12"); // typed while it is in flight
    release();
    await first;
    await editor.flush("a");
    const patches = calls.filter((c) => c[0] === "PATCH");
    expect(patches.map((p) => [p[2].base_version, p[2].source])).toEqual([
      [1, "z1"],
      [2, "z12"],
    ]);
  });
  it("test_fr_s3_own_save_updates_the_version_without_replacing_the_editor", async () => {
    const { editor, doc, changes, saved } = setupEditor((m) => (m === "PATCH" ? ok(cell("a", 2, "z")) : ok({})));
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(doc.versionOf("a")).toBe(2);
    expect(saved).toEqual([["a", 2]]);
    expect(changes).toEqual([]); // no "updated" change: the DOM is not rebuilt, focus and cursor stay
  });
  it("test_fr_s3_dispose_saves_and_unlocks_in_one_keepalive_request", async () => {
    const { editor, calls, inits } = setupEditor((m) => (m === "PATCH" ? ok(cell("a", 2, "kept")) : ok({})));
    editor.localChange("a", "first");
    await editor.flush("a"); // lock held
    editor.localChange("a", "last words"); // unsent
    calls.length = 0;
    inits.length = 0;
    await editor.dispose(true);
    expect(calls.map((c) => [c[0], c[1]])).toEqual([["DELETE", "/cells/a/lock"]]);
    expect(calls[0][2]).toEqual({ source: "last words", base_version: 2 });
    expect(inits[0].keepalive).toBe(true);
  });
  it("test_fr_s3_dispose_without_pending_just_unlocks_and_swallows_errors", async () => {
    const { editor, calls, errors } = setupEditor((m) =>
      m === "PATCH"
        ? ok(cell("a", 2, "z"))
        : m === "DELETE"
        ? ok({ error: { code: "unauthorized", message: "x" } }, 401)
        : ok({})
    );
    editor.localChange("a", "z");
    await editor.flush("a");
    calls.length = 0;
    await editor.dispose();
    expect(calls.map((c) => c[0] + " " + c[1])).toEqual(["DELETE /cells/a/lock"]);
    expect(errors).toEqual([]);
  });
  it("test_fr_s3_after_dispose_nothing_is_sent_or_scheduled", async () => {
    const { editor, calls, timers } = setupEditor(() => ok({}));
    await editor.dispose();
    editor.localChange("a", "z");
    expect(timers).toEqual([]);
    await editor.flush("a");
    expect(calls).toEqual([]);
  });
});

describe("FR-A3 gating of edit and interrupt controls", () => {
  const mkControls = () => {
    const c: any = {};
    for (const k of [
      "insertCell",
      "removeCell",
      "moveCell",
      "moveCellToIndex",
      "changeCellType",
      "setCellProperty",
      "resetCell",
      "clearCell",
      "clearAllCells",
      "runCell",
      "runAllCells",
    ])
      c[k] = jest.fn(() => "local");
    return c;
  };
  const session = async (caps: string[]) => {
    const f = jest.fn(async (url: string) =>
      url.includes("/verify")
        ? ok({ valid: true, capabilities: caps })
        : url.includes("/document")
        ? ok({ cells: [cell("a", 1, "x", 0)] })
        : ok({}, 200)
    );
    const s = (await connectShare({
      href: `https://ash.test/?manager=http://m:1&kernel=k1#token=${TOKEN}`,
      replaceAddress: () => undefined,
      clientFactory: (o: any) => new ShareClient({ ...o, fetchImpl: f as any }),
    }))!;
    f.mockClear();
    return { s, f };
  };

  it("test_fr_a3_edit_share_routes_structure_edits_to_the_kernel", async () => {
    const { s, f } = await session(["read", "edit"]);
    const doc = new ShareDoc(s.cells);
    const editor = new ShareEditor(s.client, doc, { onError: jest.fn(), onChange: jest.fn(), onConflict: jest.fn() });
    const c = mkControls();
    gateControls(c, s, jest.fn(), { editor, doc });
    c.insertCell({ position: "after", adjacentCellId: "a", data: { textContent: "t" } });
    await new Promise((r) => setTimeout(r, 0));
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toContain("/cells");
    expect(JSON.parse(init.body)).toEqual({ source: "t", after: "a" });
    // type and property changes stay blocked
    expect(c.changeCellType({})).toBe(false);
    expect(c.setCellProperty({})).toBe(false);
    // no execute: runs send nothing
    expect(c.runCell({ id: "a" })).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("test_fr_a3_without_edit_the_structure_controls_send_nothing", async () => {
    const { s, f } = await session(["read", "execute"]);
    const doc = new ShareDoc(s.cells);
    const editor = new ShareEditor(s.client, doc, { onError: jest.fn(), onChange: jest.fn(), onConflict: jest.fn() });
    const c = mkControls();
    gateControls(c, s, jest.fn(), { editor, doc });
    expect(c.insertCell({ position: "notebookEnd" })).toBe(false);
    expect(c.removeCell({ id: "a" })).toBe(false);
    expect(c.moveCell({ id: "a", amount: 1 })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it("test_fr_a3_error_type_is_http_error", () => {
    expect(new ShareHttpError(409, { error: { code: "locked", message: "x" } }).code).toBe("locked");
  });
});
