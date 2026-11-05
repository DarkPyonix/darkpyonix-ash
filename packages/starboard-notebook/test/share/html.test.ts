/**
 * @jest-environment jsdom
 */
import {
  buildSrcdoc,
  htmlOutputBlock,
  htmlOutputToElement,
  isSafeUrl,
  outputsToElement,
  sanitizeHtml,
  SANDBOX_CSP,
} from "../../src/share";

// jsdom lacks `srcdoc`; reflect it like a browser does so the sandbox feature check passes.
beforeAll(() => {
  if (!("sandbox" in HTMLIFrameElement.prototype)) {
    Object.defineProperty(HTMLIFrameElement.prototype, "sandbox", { get: () => ({}) });
  }
  if (!("srcdoc" in HTMLIFrameElement.prototype)) {
    Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
      get() {
        return this.getAttribute("srcdoc") ?? "";
      },
      set(v: string) {
        this.setAttribute("srcdoc", v);
      },
    });
  }
});

const clean = (h: string) => sanitizeHtml(h, document);

describe("FR-R4 html output isolation (XSS)", () => {
  const attacks: Record<string, string> = {
    script: `<p>hi</p><script>alert(1)</script>`,
    img_onerror: `<img src=x onerror="alert(1)">`,
    svg_onload: `<svg onload="alert(1)"><circle/></svg>`,
    svg_script: `<svg><script>alert(1)</script></svg>`,
    svg_foreignobject: `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
    js_href: `<a href="javascript:alert(1)">x</a>`,
    js_href_obfuscated: `<a href="  jav&#x09;ascript:alert(1)">x</a>`,
    data_html_href: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
    nested_iframe: `<iframe src="https://evil.test"></iframe>`,
    iframe_srcdoc: `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
    object_embed: `<object data="x.swf"></object><embed src="x.swf">`,
    meta_refresh: `<meta http-equiv="refresh" content="0;url=https://evil.test">`,
    base_tag: `<base href="https://evil.test/"><a href="a">x</a>`,
    form: `<form action="https://evil.test"><input name=a><button>go</button></form>`,
    style_import: `<style>@import url(https://evil.test/a.css)</style><p style="background:url(https://evil.test/x)">x</p>`,
    event_attr_case: `<div OnClick="alert(1)" onMouseOver="alert(2)">x</div>`,
    remote_img: `<img src="https://evil.test/track.png">`,
    svg_data_img: `<img src="data:image/svg+xml;base64,PHN2Zy8+">`,
    video: `<video src="x" onerror="alert(1)"></video><audio src="x"></audio>`,
    template: `<template><script>alert(1)</script></template>`,
  };

  for (const [name, html] of Object.entries(attacks)) {
    it(`test_fr_r4_sanitizer_removes_${name}`, () => {
      const out = clean(html).toLowerCase();
      for (const bad of [
        "<script",
        "onerror",
        "onload",
        "onclick",
        "onmouseover",
        "javascript:",
        "<iframe",
        "<object",
        "<embed",
        "<meta",
        "<base",
        "<form",
        "<input",
        "<button",
        "<video",
        "<audio",
        "<template",
        "foreignobject",
        "@import",
        "url(",
        "evil.test/track",
        "data:text/html",
        "image/svg",
      ]) {
        expect(out).not.toContain(bad);
      }
    });
  }

  it("test_fr_r4_only_safe_urls_survive", () => {
    expect(isSafeUrl("https://a.test/", "href")).toBe(true);
    expect(isSafeUrl("mailto:a@b.test", "href")).toBe(true);
    expect(isSafeUrl("javascript:alert(1)", "href")).toBe(false);
    expect(isSafeUrl("JaVa\nScRiPt:alert(1)", "href")).toBe(false);
    expect(isSafeUrl("data:text/html,<b>", "href")).toBe(false);
    expect(isSafeUrl("data:image/png;base64,AAAA", "src")).toBe(true);
    expect(isSafeUrl("data:image/svg+xml;base64,AAAA", "src")).toBe(false);
    expect(isSafeUrl("https://a.test/x.png", "src")).toBe(false);
  });

  it("test_fr_r4_links_get_noopener_noreferrer_and_blank_target", () => {
    const out = clean(`<a href="https://a.test/">x</a>`);
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("test_fr_r4_frame_has_an_empty_sandbox_and_a_default_none_csp", () => {
    const f = htmlOutputToElement(document, `<p>x</p><script>alert(1)</script>`) as HTMLIFrameElement;
    expect(f.getAttribute("sandbox")).toBe(""); // no allow-scripts, no allow-same-origin, nothing
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("csp")).toBe(SANDBOX_CSP);
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("script-src 'none'");
    expect(SANDBOX_CSP).toContain("frame-src 'none'");
    expect(f.srcdoc).toContain("Content-Security-Policy");
    expect(f.srcdoc).not.toContain("<script");
    expect(f.srcdoc).toContain("<p>x</p>");
  });

  it("test_fr_r4_srcdoc_cannot_be_closed_early_by_the_output", () => {
    const doc = buildSrcdoc(clean(`</body></html><script>alert(1)</script><img src=x onerror=alert(1)>`));
    expect(doc.toLowerCase()).not.toContain("<script");
    expect(doc.toLowerCase()).not.toContain("onerror");
  });

  it("test_fr_r4_no_postmessage_or_allow_attributes_in_the_frame", () => {
    const f = htmlOutputToElement(document, "<p>x</p>");
    const dump = f.outerHTML.toLowerCase();
    expect(dump).not.toContain("allow-");
    expect(dump).not.toContain("postmessage");
    expect(f.getAttribute("allow")).toBeNull();
  });

  it("test_fr_r4_html_is_text_until_the_viewer_asks", () => {
    const box = outputsToElement(document, [
      { output_type: "display_data", data: { "text/html": "<b>hi</b>", "text/plain": "hi (text)" } },
    ]);
    expect(box.querySelector("iframe")).toBeNull();
    expect(box.textContent).toContain("hi (text)");
    expect(box.textContent).not.toContain("<b>");
    const btn = box.querySelector("button") as HTMLButtonElement;
    expect(btn.textContent).toBe("격리된 틀에서 HTML 보기");
    btn.click();
    const frame = box.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.srcdoc).toContain("<b>hi</b>");
  });

  it("test_fr_r4_without_plain_text_a_korean_notice_is_shown", () => {
    const b = htmlOutputBlock(document, "<b>x</b>", "");
    expect(b.textContent).toContain("HTML 출력입니다");
  });

  it("test_fr_r4_unsupported_browser_never_gets_a_frame", () => {
    const real = document.createElement.bind(document);
    const spy = jest.spyOn(document, "createElement").mockImplementation((t: string, o?: any) => {
      const el: any = real(t, o);
      if (t === "iframe") {
        return Object.create(null, { tagName: { value: "IFRAME" }, setAttribute: { value: () => undefined } });
      }
      return el;
    });
    const b = htmlOutputBlock(document, "<b>x</b>", "t");
    spy.mockRestore();
    expect(b.querySelector("button")).toBeNull();
    expect(b.textContent).toContain("격리해서 보여 줄 수 없습니다");
  });

  it("test_fr_r4_oversized_html_is_not_rendered_at_all", () => {
    const huge = "<p>" + "a".repeat(1_000_001) + "</p>";
    const box = outputsToElement(document, [
      { output_type: "display_data", data: { "text/html": huge, "text/plain": "p" } },
    ]);
    expect(box.querySelector("button")).toBeNull();
    expect(box.querySelector("iframe")).toBeNull();
    expect(box.textContent).toBe("p");
  });
});
