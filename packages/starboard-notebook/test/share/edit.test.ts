import { ShareClient, ShareDoc, ShareEditor, ShareHttpError, connectShare, gateControls } from "../../src/share";

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
  const f = jest.fn(async (url: string, init: any) => {
    const u = url.replace("http://m:1/api/kernels/k1", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push([init.method, u, body]);
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
  const editor = new ShareEditor(
    client,
    doc,
    { onError: (m) => errors.push(m), onChange: (c) => changes.push(c), onConflict: (id) => conflicts.push(id) },
    {
      setTimeoutImpl: (fn, ms) => {
        const t: Timer = Object.assign(() => fn(), { ms });
        timers.push(t);
        return t;
      },
      clearTimeoutImpl: (t) => ((t as Timer).cleared = true),
    }
  );
  return { editor, doc, calls, errors, changes, conflicts, timers };
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
    expect(changes.length).toBe(1);
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
    const { editor, calls, errors } = setupEditor((m) => (m === "PUT" ? ok({ code: "locked" }, 409) : ok({})));
    editor.localChange("a", "z");
    await editor.flush("a");
    expect(calls.map((c) => c[0])).toEqual(["PUT"]);
    expect(errors).toEqual(["다른 사용자가 수정 중인 셀입니다"]);
  });
  it("test_fr_s3_stale_version_is_a_conflict_and_drops_the_edit", async () => {
    const { editor, errors, conflicts } = setupEditor((m) => (m === "PATCH" ? ok({ code: "conflict" }, 409) : ok({})));
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
    expect(new ShareHttpError(409, { code: "locked" }).code).toBe("locked");
  });
});
