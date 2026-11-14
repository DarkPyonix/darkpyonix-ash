import { connectShare, documentToCells, gateControls, ShareConnectError, ShareClient } from "../../src/share";

const TOKEN = "tok-not-a-real-secret";
const href = `https://ash.test/?manager=http://m:1&kernel=k1#${TOKEN}`;
const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function deps(responses: Record<string, any>, replaced: string[] = []) {
  const f = jest.fn(async (url: string, init: any) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    return key ? responses[key] : ok({}, 404);
  });
  return {
    f,
    d: {
      href,
      replaceAddress: (u: string) => replaced.push(u),
      clientFactory: (o: any) => new ShareClient({ ...o, fetchImpl: f as any }),
    },
  };
}

describe("FR-A2 share page", () => {
  it("test_fr_a2_page_removes_the_token_from_the_address_right_after_reading", async () => {
    const replaced: string[] = [];
    const { d } = deps(
      { "/verify": ok({ valid: true, capabilities: ["read"] }), "/document": ok({ cells: [] }) },
      replaced
    );
    await connectShare(d);
    expect(replaced).toEqual(["https://ash.test/?manager=http%3A%2F%2Fm%3A1&kernel=k1"]);
    expect(replaced.join()).not.toContain(TOKEN);
  });
  it("test_fr_a2_not_a_share_link_returns_null", async () => {
    expect(await connectShare({ href: "https://ash.test/", replaceAddress: jest.fn() })).toBeNull();
  });
  it("test_fr_a2_missing_manager_is_reported_in_korean", async () => {
    const e = await connectShare({ href: `https://ash.test/#token=${TOKEN}`, replaceAddress: jest.fn() }).catch(
      (x: any) => x
    );
    expect(e).toBeInstanceOf(ShareConnectError);
    expect(e.failure).toBe("missing_target");
    expect(e.message).toContain("매니저");
  });
  it("test_fr_a2_revoked_and_unauthorized_are_distinct", async () => {
    const r = await connectShare(
      deps({ "/verify": ok({ error: { code: "token_revoked", message: "x" } }, 401) }).d
    ).catch((x: any) => x);
    expect(r.failure).toBe("revoked");
    const u = await connectShare(
      deps({ "/verify": ok({ error: { code: "unauthorized", message: "x" } }, 401) }).d
    ).catch((x: any) => x);
    expect(u.failure).toBe("unauthorized");
    const n = await connectShare(deps({}).d).catch((x: any) => x);
    expect(n.failure).toBe("not_found");
  });
});

describe("FR-A3 share page gating", () => {
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
    const { d, f } = deps({
      "/verify": ok({ valid: true, capabilities: caps }),
      "/document": ok({ cells: [{ cell_id: "c1", type: "code", source: "x=1\n" }] }),
      "/runs": ok({}, 202),
    });
    const s = (await connectShare(d))!;
    f.mockClear();
    return { s, f };
  };

  it("test_fr_a3_read_only_share_is_read_only_and_runs_nothing", async () => {
    const { s, f } = await session(["read", "history"]);
    expect(s.readOnly).toBe(true);
    expect(s.banner).toContain("읽기 전용");
    const c = mkControls();
    const local = { ...c };
    gateControls(c, s, jest.fn());
    expect(c.runCell({ id: "c1" })).toBe(false);
    await c.runAllCells({});
    expect(f).not.toHaveBeenCalled();
    expect(local.runCell).not.toHaveBeenCalled();
  });
  it("test_fr_a3_execute_runs_remotely_never_locally", async () => {
    const { s, f } = await session(["read", "execute"]);
    expect(s.readOnly).toBe(false);
    const c = mkControls();
    const local = { ...c };
    gateControls(c, s, jest.fn());
    expect(c.runCell({ id: "c1" })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toContain("/api/kernels/k1/runs");
    expect(JSON.parse(init.body)).toEqual({ mode: "cells", cell_ids: ["c1"], on_busy: "reject" });
    expect(local.runCell).not.toHaveBeenCalled();
  });
  it("test_fr_a3_edits_are_blocked_in_share_mode", async () => {
    const { s } = await session(["read", "edit", "execute"]);
    const c = mkControls();
    gateControls(c, s, jest.fn());
    expect(c.insertCell({})).toBe(false);
    expect(c.removeCell({ id: "c1" })).toBe(false);
    expect(c.setCellProperty({})).toBe(false);
  });
  it("test_fr_a3_document_cells_become_locked_notebook_cells", async () => {
    const cells = documentToCells([
      { cell_id: "c1", type: "code", source: "x=1\n" },
      { cell_id: "c2", type: "markdown", source: "hi" },
    ]);
    expect(cells.map((c: any) => [c.id, c.cellType, c.metadata.properties.locked])).toEqual([
      ["c1", "python", true],
      ["c2", "markdown", true],
    ]);
  });
});
