/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render nbformat 4 outputs (as served by the manager, SPEC FR-R4) to DOM, safely: text, data:
 * images, and `text/html` only inside the sandboxed frame of html.ts. Nothing from a shared kernel
 * is ever inserted into the page itself.
 */

import { htmlOutputBlock, MAX_HTML_BYTES, utf8Length } from "./html";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** nbformat allows `string | string[]` for text fields. */
function text(v: unknown): string {
  return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];

export function outputToElement(doc: Document, out: any): HTMLElement | null {
  if (!out || typeof out.output_type !== "string") return null;
  if (out.output_type === "stream") {
    const pre = doc.createElement("pre");
    pre.className = `share-output-stream share-output-${out.name === "stderr" ? "stderr" : "stdout"}`;
    pre.textContent = stripAnsi(text(out.text));
    return pre;
  }
  if (out.output_type === "error") {
    const pre = doc.createElement("pre");
    pre.className = "share-output-error";
    const tb =
      Array.isArray(out.traceback) && out.traceback.length
        ? out.traceback.join("\n")
        : [out.ename, out.evalue].filter((x) => typeof x === "string" && x).join(": ") || "오류";
    pre.textContent = stripAnsi(tb);
    return pre;
  }
  if (out.output_type === "display_data" || out.output_type === "execute_result") {
    const data = out.data ?? {};
    const img = IMAGE_TYPES.find((t) => typeof text(data[t]) === "string" && text(data[t]).length > 0);
    if (img) {
      const el = doc.createElement("img");
      el.src = `data:${img};base64,${text(data[img]).replace(/\s+/g, "")}`;
      el.className = "share-output-image";
      return el;
    }
    const html = text(data["text/html"]);
    const plain = text(data["text/plain"]);
    if (html && utf8Length(html) <= MAX_HTML_BYTES) return htmlOutputBlock(doc, html, stripAnsi(plain));
    if (plain) {
      const pre = doc.createElement("pre");
      pre.className = "share-output-text";
      pre.textContent = stripAnsi(plain);
      return pre;
    }
  }
  return null;
}

export function outputsToElement(doc: Document, outputs: unknown): HTMLElement {
  const box = doc.createElement("div");
  box.className = "share-output";
  if (Array.isArray(outputs)) {
    for (const o of outputs) {
      const el = outputToElement(doc, o);
      if (el) box.append(el);
    }
  }
  return box;
}
