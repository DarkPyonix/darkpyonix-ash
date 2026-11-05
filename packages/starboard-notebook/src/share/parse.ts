/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Share link parsing (darkpyonix SPEC FR-A2, FR-H4).
 *
 * A share link is `<share_base>/<share_id>#<token>` (share_id `s_` + 16 hex). The token lives in
 * the fragment so it never reaches the hub; `?token=` is also accepted on share links (FR-A2).
 * The link does not name the kernel or the manager. Direct connections (no hub) pass them with
 * the ash-local query parameters `manager` (base URL) and `kernel` (kernel id).
 */

export const SHARE_ID_RE = /^s_[0-9a-f]{16}$/;

export interface ShareLink {
  token: string;
  shareId?: string;
  managerUrl?: string;
  kernelId?: string;
}

export function parseShareLink(href: string): ShareLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const frag = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : "");
  // A bare fragment is the token itself (`#<token>`); `#token=<token>` is also fine.
  const bareFragment = url.hash.length > 1 && !url.hash.includes("=") ? url.hash.slice(1) : null;
  const token = frag.get("token") || bareFragment || url.searchParams.get("token");
  if (!token) return null;

  const last = url.pathname.split("/").filter(Boolean).pop();
  const link: ShareLink = { token };
  if (last && SHARE_ID_RE.test(last)) link.shareId = last;
  const manager = url.searchParams.get("manager");
  if (manager) link.managerUrl = manager.replace(/\/+$/, "");
  const kernel = url.searchParams.get("kernel");
  if (kernel) link.kernelId = kernel;
  return link;
}

/** Remove the token from the address bar so it is not kept in history or copied by accident. */
export function stripTokenFromLocation(href: string): string {
  const url = new URL(href);
  url.hash = "";
  url.searchParams.delete("token");
  return url.toString();
}
