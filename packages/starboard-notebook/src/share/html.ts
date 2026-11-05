/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `text/html` outputs of a shared kernel are untrusted: they come from another person's code.
 * By default they are NOT rendered: the page shows the `text/plain` alternative (or a Korean
 * notice) and a button. Only when the viewer asks, and only if the browser supports sandboxed
 * `srcdoc` frames, the HTML is shown inside an iframe with an EMPTY `sandbox` attribute (no scripts, no same
 * origin, no forms, no popups, no top navigation), a `srcdoc` that carries a restrictive CSP
 * (nothing loads except `data:` images and inline styles), and HTML that was sanitized first as a
 * second layer. There is no postMessage channel in either direction; the frame has a fixed size
 * and scrolls.
 */

/** Largest HTML output rendered, in UTF-8 bytes; bigger ones fall back to `text/plain`. */
export const MAX_HTML_BYTES = 1_000_000;

export function utf8Length(s: string): number {
  return typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(s).length
    : unescape(encodeURIComponent(s)).length;
}

export const SANDBOX_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; script-src 'none'";

/** Elements removed with their content. */
const DROP = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "meta",
  "link",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "foreignobject",
  "animate",
  "set",
  "use",
  "template",
  "noscript",
  // image maps: <area href target> cannot be forced to a safe target and could navigate the frame
  "map",
  "area",
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "background",
  "srcset",
  "data",
]);

/** Only these URLs survive: plain web links and data images (never data:text/html or svg). */
export function isSafeUrl(value: string, attr: string): boolean {
  const v = value.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
  if (attr === "src") return /^data:image\/(png|jpeg|gif);base64,[a-z0-9+/=]*$/.test(v);
  if (attr === "href") return /^(https?:|mailto:|#)/.test(v);
  return false;
}

function clean(el: Element) {
  for (const child of Array.from(el.children)) {
    const tag = child.localName.toLowerCase();
    // Style sheets that pull anything in or use legacy script hooks are dropped (the CSP blocks them too).
    if (
      tag === "style" &&
      /@import|url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(child.textContent ?? "")
    ) {
      child.remove();
      continue;
    }
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    clean(child);
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (
      name.startsWith("on") ||
      name === "srcdoc" ||
      (name === "style" && /expression|javascript:|url\s*\(/i.test(attr.value))
    ) {
      el.removeAttribute(attr.name);
    } else if (URL_ATTRS.has(name) && !isSafeUrl(attr.value, name)) {
      el.removeAttribute(attr.name);
    }
  }
  if (el.localName === "a") {
    el.setAttribute("rel", "noopener noreferrer nofollow");
    el.setAttribute("target", "_blank");
  }
}

/** Sanitize an HTML fragment; the result is a string for the `<body>` of the sandboxed document. */
export function sanitizeHtml(html: string, doc: Document): string {
  const parsed = new (doc.defaultView as any).DOMParser().parseFromString(`<body>${html}`, "text/html") as Document;
  clean(parsed.body);
  return parsed.body.innerHTML;
}

/** The full document placed in `srcdoc`. */
export function buildSrcdoc(safeBody: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><style>body{margin:8px;font:14px system-ui,sans-serif;color:#222;background:#fff}img{max-width:100%}</style></head><body>${safeBody}</body></html>`;
}

/** An inert, isolated frame for one `text/html` output. */
export function htmlOutputToElement(doc: Document, html: string): HTMLElement {
  const frame = doc.createElement("iframe");
  frame.className = "share-output-html";
  frame.setAttribute("sandbox", ""); // nothing allowed: no scripts, no same-origin, no popups
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("title", "공유된 HTML 출력");
  frame.setAttribute(
    "style",
    "width:100%;height:300px;border:1px solid #ccc;resize:vertical;overflow:auto;background:#fff"
  );
  // `csp` makes the browser enforce the policy on the framed document itself (Chromium).
  frame.setAttribute("csp", SANDBOX_CSP);
  frame.srcdoc = buildSrcdoc(sanitizeHtml(html, doc));
  return frame;
}

/** True when the browser enforces `sandbox` and `srcdoc` on iframes (otherwise HTML is never shown). */
export function canSandbox(doc: Document): boolean {
  const probe = doc.createElement("iframe") as any;
  return "sandbox" in probe && "srcdoc" in probe;
}

/**
 * Default view of an HTML output: text only, plus a button that swaps in the isolated frame.
 * `fallbackText` is the `text/plain` alternative when the kernel sent one.
 */
export function htmlOutputBlock(doc: Document, html: string, fallbackText: string): HTMLElement {
  const box = doc.createElement("div");
  box.className = "share-output-html-block";
  const note = doc.createElement("pre");
  note.className = "share-output-text";
  note.textContent = fallbackText || "HTML 출력입니다. 보안을 위해 기본으로는 표시하지 않습니다.";
  box.append(note);
  if (!canSandbox(doc)) {
    const warn = doc.createElement("div");
    warn.className = "share-output-html-unsupported";
    warn.textContent = "이 브라우저는 HTML 출력을 격리해서 보여 줄 수 없습니다.";
    box.append(warn);
    return box;
  }
  const btn = doc.createElement("button");
  btn.className = "btn btn-sm btn-outline-secondary share-output-html-show";
  btn.setAttribute("type", "button");
  btn.textContent = "격리된 틀에서 HTML 보기";
  btn.addEventListener("click", () => {
    box.replaceChildren(htmlOutputToElement(doc, html));
  });
  box.append(btn);
  return box;
}
