/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Isolated renderer frame for notebook outputs that need scripts (SPEC NFR-H3, INTENT D15).
 *
 * Unlike `html.ts` (FR-R4), which strips `<script>` and uses `sandbox=""` + `srcdoc` for inert HTML,
 * NFR-H3 runs script-capable outputs (Plotly, Bokeh, interactive widgets) ONLY inside a dedicated
 * `<iframe sandbox="allow-scripts">` (never `allow-same-origin`) that loads the renderer page
 * (`/sandbox/`, e.g. `https://darkpyonix.dev/sandbox/`) and receives the untrusted HTML via
 * `postMessage`.
 *
 * Why a fetched `/sandbox/` document instead of `srcdoc` or `blob:`:
 * - `srcdoc` and `blob:` documents inherit the parent page's CSP, which blocks inline scripts inside
 *   notebook outputs. A fetched `/sandbox/` document carries its own response headers / CSP.
 * - Moving the renderer to a separate registered domain later only changes `sandboxUrl`.
 *
 * Security invariants enforced by the browser and verified by
 * `test_nfr_h3_untrusted_output_cannot_reach_the_front_or_the_api`:
 * 1. `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an opaque (`null`) origin.
 * 2. Inside the frame, `document.cookie` and `localStorage` throw `SecurityError`, and
 *    `parent.document` is inaccessible (`SecurityError` / `undefined`).
 * 3. `fetch("https://api.darkpyonix.dev/me", { credentials: "include" })` from inside the frame is a
 *    cross-site request from `Origin: null`: `SameSite=Lax` session cookies are NOT sent, the API
 *    returns `401` without `Access-Control-Allow-Origin` (FR-H13), and the frame cannot read the
 *    response.
 */

import { MAX_HTML_BYTES, utf8Length } from "./html";

/** Default path of the sandbox renderer page (overridable when moved to a separate domain). */
export const DEFAULT_SANDBOX_URL = "/sandbox/";

/** Only `allow-scripts` is granted; `allow-same-origin` is strictly forbidden (NFR-H3). */
export const NFR_H3_SANDBOX_FLAGS = "allow-scripts";

/** CSP of the `/sandbox/` renderer document itself: scripts and inline styles may run inside the
 * opaque origin, while framing, `<base>`, and `<object>` are forbidden. */
export const SANDBOX_RENDERER_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http: data:; img-src https: http: data: blob:; font-src https: http: data:; connect-src https: http:; base-uri 'none'; form-action 'none'; frame-ancestors *";

/** Message sent from the parent notebook page to the `/sandbox/` iframe once it has loaded. */
export interface SandboxRenderMessage {
  type: "darkpyonix:sandbox-render";
  html: string;
}

/**
 * Returns the HTML source of the `/sandbox/` renderer page served at `https://darkpyonix.dev/sandbox/`.
 * It listens for a single `{ type: "darkpyonix:sandbox-render", html }` message from `window.parent`
 * and renders the HTML (including `<script>` tags) inside its opaque-origin document body.
 */
export function sandboxRendererPageHtml(csp: string = SANDBOX_RENDERER_CSP): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>body{margin:8px;font:14px system-ui,sans-serif;color:#222;background:#fff}img{max-width:100%}</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var rendered = false;
  window.addEventListener("message", function (ev) {
    if (rendered) return;
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || d.type !== "darkpyonix:sandbox-render" || typeof d.html !== "string") return;
    rendered = true;
    var root = document.getElementById("root");
    if (!root) return;
    var range = document.createRange();
    range.selectNode(root);
    root.innerHTML = "";
    root.appendChild(range.createContextualFragment(d.html));
  });
})();
</script>
</body>
</html>`;
}

export interface SandboxFrameOptions {
  /** URL of the renderer page; defaults to `/sandbox/` (`https://darkpyonix.dev/sandbox/`). */
  sandboxUrl?: string;
}

/**
 * Creates the NFR-H3 sandboxed iframe (`sandbox="allow-scripts"`, never `allow-same-origin`,
 * `src="/sandbox/"`, never `srcdoc` or `blob:`) and posts the untrusted HTML to it on `load`.
 */
export function createSandboxedOutputFrame(
  doc: Document,
  html: string,
  options: SandboxFrameOptions = {}
): HTMLIFrameElement {
  if (utf8Length(html) > MAX_HTML_BYTES) {
    throw new RangeError(`HTML output exceeds ${MAX_HTML_BYTES} bytes`);
  }
  const sandboxUrl = options.sandboxUrl ?? DEFAULT_SANDBOX_URL;
  if (/^(srcdoc|blob|data|javascript):/i.test(sandboxUrl.trim())) {
    throw new Error("NFR-H3 sandbox renderer URL must be an HTTP(S) or relative path, never blob:/data:/javascript:");
  }
  const frame = doc.createElement("iframe");
  frame.className = "share-output-sandbox";
  frame.setAttribute("sandbox", NFR_H3_SANDBOX_FLAGS);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "격리된 스크립트 출력");
  frame.setAttribute(
    "style",
    "width:100%;height:300px;border:1px solid #ccc;resize:vertical;overflow:auto;background:#fff"
  );
  const msg: SandboxRenderMessage = {
    type: "darkpyonix:sandbox-render",
    html,
  };
  frame.addEventListener("load", () => {
    // The sandboxed frame has an opaque (`null`) origin, so targetOrigin must be "*".
    // No secret or token is ever placed in `msg`: only the notebook output HTML to render.
    frame.contentWindow?.postMessage(msg, "*");
  });
  frame.setAttribute("src", sandboxUrl);
  return frame;
}
