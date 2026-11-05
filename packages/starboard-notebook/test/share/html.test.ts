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
  const out = (html: string) => new DOMParser().parseFromString(`<body>${clean(html)}`, "text/html").body;

  // Per attack: the dangerous element/attribute must really be gone (positive assertion on the DOM),
  // and the harmless text next to it must survive (so the test cannot pass by deleting everything).
  const attacks: Record<string, { html: string; absent: string[]; keepText?: string }> = {
    script: { html: `<p>hi</p><script>alert(1)</script>`, absent: ["script"], keepText: "hi" },
    img_onerror: {
      html: `<p>t</p><img src=x onerror="alert(1)">`,
      absent: ["img[onerror]", "img[src='x']"],
      keepText: "t",
    },
    svg_onload: { html: `<p>t</p><svg onload="alert(1)"><circle/></svg>`, absent: ["svg[onload]"], keepText: "t" },
    svg_script: { html: `<p>t</p><svg><script>alert(1)</script></svg>`, absent: ["script"], keepText: "t" },
    svg_foreignobject: {
      html: `<p>t</p><svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
      absent: ["foreignObject", "foreignobject", "iframe"],
      keepText: "t",
    },
    svg_use: { html: `<p>t</p><svg><use href="data:image/svg+xml,x"/></svg>`, absent: ["use"], keepText: "t" },
    js_href: { html: `<p>t</p><a href="javascript:alert(1)">x</a>`, absent: ["a[href^='javascript']"], keepText: "x" },
    js_href_obfuscated: {
      html: `<p>t</p><a href="  jav&#x09;ascript:alert(1)">x</a>`,
      absent: ["a[href]"],
      keepText: "x",
    },
    data_html_href: { html: `<p>t</p><a href="data:text/html;base64,AAAA">x</a>`, absent: ["a[href]"], keepText: "x" },
    nested_iframe: { html: `<p>t</p><iframe src="https://evil.test"></iframe>`, absent: ["iframe"], keepText: "t" },
    iframe_srcdoc: {
      html: `<p>t</p><iframe srcdoc="<script>alert(1)</script>"></iframe>`,
      absent: ["iframe", "[srcdoc]"],
      keepText: "t",
    },
    object_embed: {
      html: `<p>t</p><object data="x.swf"></object><embed src="x.swf">`,
      absent: ["object", "embed"],
      keepText: "t",
    },
    meta_refresh: {
      html: `<p>t</p><meta http-equiv="refresh" content="0;url=https://evil.test">`,
      absent: ["meta"],
      keepText: "t",
    },
    meta_csp_override: {
      html: `<p>t</p><meta http-equiv="Content-Security-Policy" content="default-src *">`,
      absent: ["meta"],
      keepText: "t",
    },
    base_tag: {
      html: `<base href="https://evil.test/"><a href="a">x</a>`,
      absent: ["base", "a[href='a']"],
      keepText: "x",
    },
    link_tag: {
      html: `<p>t</p><link rel="stylesheet" href="https://evil.test/a.css">`,
      absent: ["link"],
      keepText: "t",
    },
    form: {
      html: `<p>t</p><form action="https://evil.test"><input name=a><button>go</button></form>`,
      absent: ["form", "input", "button"],
      keepText: "t",
    },
    image_map: {
      html: `<p>t</p><img src="data:image/png;base64,AAAA" usemap="#m"><map name="m"><area href="https://evil.test" shape="default"></map>`,
      absent: ["map", "area", "area[href]"],
      keepText: "t",
    },
    style_import: {
      html: `<p>t</p><style>@import url(https://evil.test/a.css)</style>`,
      absent: ["style"],
      keepText: "t",
    },
    style_attr_url: {
      html: `<p style="background:url(https://evil.test/x)">t</p>`,
      absent: ["[style]"],
      keepText: "t",
    },
    event_attr_case: {
      html: `<div OnClick="alert(1)" onMouseOver="alert(2)">x</div>`,
      absent: ["[onclick]", "[onmouseover]"],
      keepText: "x",
    },
    remote_img: { html: `<p>t</p><img src="https://evil.test/track.png">`, absent: ["img[src]"], keepText: "t" },
    svg_data_img: {
      html: `<p>t</p><img src="data:image/svg+xml;base64,PHN2Zy8+">`,
      absent: ["img[src]"],
      keepText: "t",
    },
    video_audio: {
      html: `<p>t</p><video src="x" onerror="alert(1)"></video><audio src="x"></audio>`,
      absent: ["video", "audio"],
      keepText: "t",
    },
    template: {
      html: `<p>t</p><template><script>alert(1)</script></template>`,
      absent: ["template", "script"],
      keepText: "t",
    },
    post_message: {
      html: `<p>t</p><script>parent.postMessage(document.cookie,'*')</script>`,
      absent: ["script"],
      keepText: "t",
    },
  };

  for (const [name, a] of Object.entries(attacks)) {
    it(`test_fr_r4_sanitizer_removes_${name}`, () => {
      const body = out(a.html);
      for (const sel of a.absent) expect(body.querySelector(sel)).toBeNull();
      if (a.keepText) expect(body.textContent).toContain(a.keepText);
      expect(clean(a.html).toLowerCase()).not.toContain("postmessage");
    });
  }

  it("test_fr_r4_harmless_html_is_preserved", () => {
    const body = out(
      `<table><tr><th>a</th><td style="color:red">1</td></tr></table><p><b>hi</b> <i>there</i> <a href="https://a.test/x">link</a> <a href="#top">top</a></p><img src="data:image/png;base64,AAAA" alt="pic"><style>td{color:blue}</style><svg><circle r="2"></circle></svg>`
    );
    expect(body.querySelector("table td")?.getAttribute("style")).toBe("color:red");
    expect(body.querySelector("b")?.textContent).toBe("hi");
    expect(body.querySelector("a[href='https://a.test/x']")).not.toBeNull();
    expect(body.querySelector("a[href='#top']")).not.toBeNull();
    expect(body.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(body.querySelector("style")?.textContent).toBe("td{color:blue}");
    expect(body.querySelector("svg circle")).not.toBeNull();
  });

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
    expect(f.srcdoc.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(f.srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(f.srcdoc.indexOf("<body"));
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
    expect(f.getAttribute("name")).toBeNull();
    // hostile output that tries to talk to the page never reaches the frame document
    const hostile = htmlOutputToElement(
      document,
      `<script>parent.postMessage(1,'*')</script><img src=x onerror="parent.postMessage(1,'*')">`
    );
    expect((hostile as HTMLIFrameElement).srcdoc.toLowerCase()).not.toContain("postmessage");
    // and the page itself registers no message listener for frames (no channel in either direction)
    const src = require("fs").readFileSync(require("path").resolve(__dirname, "../../src/share/html.ts"), "utf8");
    expect(src).not.toMatch(/addEventListener\(\s*["']message["']/);
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

  it("test_fr_r4_size_limit_counts_bytes_not_characters", () => {
    const wide = "<p>" + "한".repeat(400_000) + "</p>"; // 400k characters, 1.2 MB in UTF-8
    expect(wide.length).toBeLessThan(1_000_000);
    const box = outputsToElement(document, [
      { output_type: "display_data", data: { "text/html": wide, "text/plain": "p" } },
    ]);
    expect(box.querySelector("button")).toBeNull();
    expect(box.querySelector("iframe")).toBeNull();
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
