/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The remote document as the share page knows it: cell order and per-cell versions, kept current
 * from `doc.cell.*` events (PROTOCOL section 4). Events that were already applied (a REST answer
 * and the same event over the socket) are ignored by version, so applying twice is safe.
 */

import { RemoteCell } from "./page";

export interface DocCell extends RemoteCell {
  version: number;
}

export type DocChange =
  | { kind: "created"; cell: DocCell; index: number }
  | { kind: "updated"; cell: DocCell; index: number }
  | { kind: "moved"; cell: DocCell; index: number; from: number }
  | { kind: "deleted"; cellId: string; index: number }
  | { kind: "reloaded"; cells: DocCell[] };

export class ShareDoc {
  cells: DocCell[];
  constructor(cells: RemoteCell[]) {
    this.cells = cells.map((c) => ({ ...c, version: typeof c.version === "number" ? c.version : 1 }));
  }

  indexOf(id: string) {
    return this.cells.findIndex((c) => c.cell_id === id);
  }
  versionOf(id: string): number | undefined {
    return this.cells[this.indexOf(id)]?.version;
  }

  /** Apply a kernel event (`type`, `data`); returns what changed, or null if nothing did. */
  apply(type: string, data: any): DocChange | null {
    if (!data) return null;
    const cell: DocCell | undefined = data.cell && typeof data.cell.cell_id === "string" ? data.cell : undefined;
    switch (type) {
      case "doc.cell.created": {
        if (!cell || this.indexOf(cell.cell_id) >= 0) return null;
        const index = Math.max(
          0,
          Math.min(typeof cell.index === "number" ? cell.index : this.cells.length, this.cells.length)
        );
        this.cells.splice(index, 0, cell);
        return { kind: "created", cell, index };
      }
      case "doc.cell.updated": {
        if (!cell) return null;
        const i = this.indexOf(cell.cell_id);
        if (i < 0 || cell.version <= this.cells[i].version) return null;
        this.cells[i] = cell;
        return { kind: "updated", cell, index: i };
      }
      case "doc.cell.moved": {
        if (!cell) return null;
        const from = this.indexOf(cell.cell_id);
        if (from < 0) return null;
        const to = Math.max(0, Math.min(typeof cell.index === "number" ? cell.index : from, this.cells.length - 1));
        if (to === from && cell.version <= this.cells[from].version) return null;
        this.cells.splice(from, 1);
        this.cells.splice(to, 0, cell);
        return { kind: "moved", cell, index: to, from };
      }
      case "doc.cell.deleted": {
        const i = typeof data.cell_id === "string" ? this.indexOf(data.cell_id) : -1;
        if (i < 0) return null;
        this.cells.splice(i, 1);
        return { kind: "deleted", cellId: data.cell_id, index: i };
      }
      case "doc.reloaded": {
        if (!Array.isArray(data.cells)) return null;
        this.cells = data.cells.filter((c: any) => c && typeof c.cell_id === "string");
        return { kind: "reloaded", cells: this.cells };
      }
    }
    return null;
  }

  /** Record the answer of a REST edit (same rules as the event). */
  applyResult(kind: "created" | "updated" | "moved", cell: DocCell): DocChange | null {
    return this.apply(`doc.cell.${kind}`, { cell });
  }
}
