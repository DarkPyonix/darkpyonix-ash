/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share capabilities (darkpyonix SPEC FR-A3, INTENT D18).
 * A token holds a set of capabilities; they are not tiers and have no order or implication.
 */

export const CAPABILITIES = ["read", "history", "execute", "edit", "manage"] as const;
export type Capability = typeof CAPABILITIES[number];

/** Parse the `capabilities` array of a server response. Unknown names are dropped, never guessed. */
export function parseCapabilities(raw: unknown): Set<Capability> {
  const out = new Set<Capability>();
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if ((CAPABILITIES as readonly unknown[]).includes(c)) out.add(c as Capability);
  }
  return out;
}

/** What the notebook UI may offer for a capability set. Each flag is independent (FR-A3). */
export interface ShareAbilities {
  /** See cell code. */
  canRead: boolean;
  /** See outputs and run history. */
  canSeeOutputs: boolean;
  /** Run cells and interrupt. */
  canExecute: boolean;
  /** Change cell code (lock, create, update, delete, move, start typing). */
  canEdit: boolean;
  /** Manage shares. */
  canManage: boolean;
}

export function abilitiesOf(caps: ReadonlySet<Capability>): ShareAbilities {
  return {
    canRead: caps.has("read"),
    canSeeOutputs: caps.has("history"),
    canExecute: caps.has("execute"),
    canEdit: caps.has("edit"),
    canManage: caps.has("manage"),
  };
}

/** True when the token can neither run nor edit: the notebook must be shown read-only. */
export function isReadOnly(caps: ReadonlySet<Capability>): boolean {
  return !caps.has("execute") && !caps.has("edit");
}

/** Korean label for the access banner. */
export function describeCapabilities(caps: ReadonlySet<Capability>): string {
  if (caps.size === 0) return "권한 없음";
  const names: Record<Capability, string> = {
    read: "코드 보기",
    history: "실행 기록과 출력 보기",
    execute: "실행",
    edit: "코드 수정",
    manage: "공유 관리",
  };
  return CAPABILITIES.filter((c) => caps.has(c))
    .map((c) => names[c])
    .join(", ");
}
