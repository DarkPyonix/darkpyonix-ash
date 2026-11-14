/**
 * @jest-environment jsdom
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawn } from "child_process";
import {
  createSandboxedOutputFrame,
  DEFAULT_SANDBOX_URL,
  NFR_H3_SANDBOX_FLAGS,
  sandboxRendererPageHtml,
  SANDBOX_RENDERER_CSP,
} from "../../src/share";

function findChromiumExecutable(): string | null {
  const envPath = process.env.CHROMIUM_PATH || process.env.CHROME_BIN;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const home = os.homedir();
  const candidates = [
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"
    ),
    path.join(
      home,
      "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    ),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

describe("NFR-H3 untrusted notebook output isolation", () => {
  it("test_nfr_h3_sandbox_frame_uses_allow_scripts_only_and_loads_sandbox_url", () => {
    const postSpy = jest.fn();
    const frame = createSandboxedOutputFrame(document, `<p>plot</p><script>window.x = 1;</script>`);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("src")).toBe(DEFAULT_SANDBOX_URL);
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

    Object.defineProperty(frame, "contentWindow", {
      value: { postMessage: postSpy },
      configurable: true,
    });
    frame.dispatchEvent(new Event("load"));
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(
      {
        type: "darkpyonix:sandbox-render",
        html: `<p>plot</p><script>window.x = 1;</script>`,
      },
      "*"
    );
  });

  it("test_nfr_h3_sandbox_frame_rejects_blob_data_srcdoc_and_oversized_html", () => {
    expect(() =>
      createSandboxedOutputFrame(document, "<p>x</p>", { sandboxUrl: "blob:https://darkpyonix.dev/1" })
    ).toThrow();
    expect(() => createSandboxedOutputFrame(document, "<p>x</p>", { sandboxUrl: "data:text/html,hi" })).toThrow();
    expect(() => createSandboxedOutputFrame(document, "<p>x</p>", { sandboxUrl: "javascript:alert(1)" })).toThrow();
    expect(() => createSandboxedOutputFrame(document, "a".repeat(1_000_001))).toThrow(RangeError);
  });

  it("test_nfr_h3_untrusted_output_cannot_reach_the_front_or_the_api", async () => {
    const chromeBin = findChromiumExecutable();
    expect(chromeBin).not.toBeNull();

    interface ApiCallRecord {
      origin: string | undefined;
      cookie: string | undefined;
      method: string | undefined;
    }
    const apiCalls: ApiCallRecord[] = [];
    let reportResolve: ((data: any) => void) | null = null;
    const reportPromise = new Promise<any>((resolve) => {
      reportResolve = resolve;
    });

    const rendererHtml = sandboxRendererPageHtml();
    expect(NFR_H3_SANDBOX_FLAGS).toBe("allow-scripts");
    expect(SANDBOX_RENDERER_CSP).toContain("script-src 'unsafe-inline'");

    let directExecuted = false;

    // Start the API server on a separate loopback port so that requests from the sandboxed frame
    // (`Origin: null`) test both cross-origin fetch + FR-H13 CORS denial (`Origin: null` gets 401
    // and no `Access-Control-Allow-Origin`) and FR-H14 direct content download headers.
    const apiServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/direct-executed") {
        directExecuted = true;
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/me") {
        apiCalls.push({
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          method: req.method,
        });
        // FR-H13: Origin: null is never granted CORS; missing session cookie returns 401.
        const body = JSON.stringify({ error: { code: "unauthorized", message: "missing session" } });
        res.writeHead(401, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }
      if (url.pathname === "/notebooks/nb_1/versions/1/run") {
        // FR-H14: Direct navigation to raw notebook content forces download and never renders as HTML.
        const rawHtml = `<!doctype html><html><body><script>fetch("/direct-executed")</script></body></html>`;
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": 'attachment; filename="nb_1-v1.run.json"',
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "sandbox; default-src 'none'",
        });
        res.end(rawHtml);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", () => resolve()));
    const apiPort = (apiServer.address() as any).port as number;
    const apiOrigin = `http://127.0.0.1:${apiPort}`;

    // Front server (represents https://darkpyonix.dev serving the ash notebook viewer and /sandbox/).
    const frontServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/sandbox/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": SANDBOX_RENDERER_CSP,
        });
        res.end(rendererHtml);
        return;
      }
      if (url.pathname === "/report" && req.method === "POST") {
        let raw = "";
        req.on("data", (chunk: unknown) => {
          raw += String(chunk);
        });
        req.on("end", () => {
          try {
            reportResolve?.(JSON.parse(raw));
          } catch (e) {
            reportResolve?.({ parseError: String(e) });
          }
          res.writeHead(204);
          res.end();
        });
        return;
      }
      if (url.pathname === "/notebook") {
        // Malicious text/html output with <script> attempting to:
        // 1. Read document.cookie
        // 2. Read parent.document
        // 3. Read localStorage
        // 4. Call fetch("<api>/me", { credentials: "include" })
        const untrustedOutputHtml =
          `
          <div id="plot">untrusted output</div>
          <script>
          (async function () {
            var cookieResult;
            try {
              cookieResult = { ok: true, value: String(document.cookie) };
            } catch (e) {
              cookieResult = { ok: false, name: e && e.name ? e.name : String(e) };
            }

            var parentDocResult;
            try {
              var pd = parent.document;
              parentDocResult = { ok: pd != null, value: pd ? String(pd.cookie || pd.title) : null };
            } catch (e) {
              parentDocResult = { ok: false, name: e && e.name ? e.name : String(e) };
            }

            var storageResult;
            try {
              storageResult = { ok: true, value: String(localStorage.getItem("front_secret")) };
            } catch (e) {
              storageResult = { ok: false, name: e && e.name ? e.name : String(e) };
            }

            var fetchResult;
            try {
              var r = await fetch(${JSON.stringify(`${apiOrigin}/me`)}, { credentials: "include" });
              var txt = await r.text();
              fetchResult = { readable: true, status: r.status, body: txt };
            } catch (e) {
              fetchResult = { readable: false, name: e && e.name ? e.name : String(e) };
            }

            parent.postMessage({
              type: "nfr_h3_probe_done",
              origin: window.origin,
              cookieResult: cookieResult,
              parentDocResult: parentDocResult,
              storageResult: storageResult,
              fetchResult: fetchResult
            }, "*");
          })();
          </scr` +
          `ipt>
        `;

        const pageHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ash-front</title></head>
<body>
<div id="app"></div>
<script>
  // Seed front-end secrets in the parent page's origin (cookie, localStorage, DOM).
  document.cookie = "dp_session=secret_session_cookie; Path=/; SameSite=Lax";
  localStorage.setItem("front_secret", "top_secret_value");

  var frame = document.createElement("iframe");
  frame.className = "share-output-sandbox";
  frame.setAttribute("sandbox", ${JSON.stringify(NFR_H3_SANDBOX_FLAGS)});
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.addEventListener("load", function () {
    frame.contentWindow.postMessage({
      type: "darkpyonix:sandbox-render",
      html: ${JSON.stringify(untrustedOutputHtml).replace(/<\/script/gi, "<\\/script")}
    }, "*");
  });

  window.addEventListener("message", async function (ev) {
    if (!ev.data || ev.data.type !== "nfr_h3_probe_done") return;
    // Also open the raw content URL directly in a frame to verify the browser treats it as a
    // download and never executes the script inside it (NFR-H3 / FR-H14).
    var dl = document.createElement("iframe");
    dl.src = ${JSON.stringify(`${apiOrigin}/notebooks/nb_1/versions/1/run`)};
    document.body.appendChild(dl);
    await new Promise(function (r) { setTimeout(r, 250); });
    await fetch("/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        probe: ev.data
      })
    });
  });

  frame.setAttribute("src", "/sandbox/");
  document.getElementById("app").appendChild(frame);
</script>
</body>
</html>`;

        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": "dp_session=secret_session_cookie; Path=/; SameSite=Lax",
        });
        res.end(pageHtml);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((resolve) => frontServer.listen(0, "127.0.0.1", () => resolve()));
    const frontPort = (frontServer.address() as any).port as number;
    const frontUrl = `http://127.0.0.1:${frontPort}/notebook`;

    const scratchDir = path.resolve(__dirname, "../../../../.scratch/nfr-h3-test");
    fs.mkdirSync(scratchDir, { recursive: true });
    const userDataDir = fs.mkdtempSync(path.join(scratchDir, "chrome-profile-"));
    const child = spawn(
      chromeBin!,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${userDataDir}`,
        frontUrl,
      ],
      { stdio: "ignore" }
    );

    try {
      const result: any = await Promise.race([
        reportPromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for headless browser report")), 15000)
        ),
      ]);

      const { probe } = result;
      // 1. The sandboxed frame's origin is opaque ("null").
      expect(probe.origin).toBe("null");

      // 2. document.cookie throws SecurityError (or is empty) and never contains the parent cookie.
      expect(probe.cookieResult.ok).toBe(false);
      expect(probe.cookieResult.name).toBe("SecurityError");

      // 3. parent.document is blocked by cross-origin policy.
      expect(probe.parentDocResult.ok).toBe(false);
      expect(probe.parentDocResult.name).toBe("SecurityError");

      // 4. localStorage throws SecurityError.
      expect(probe.storageResult.ok).toBe(false);
      expect(probe.storageResult.name).toBe("SecurityError");

      // 5. fetch(".../me", { credentials: "include" }) arrives at the API server with Origin: null
      //    and without cookies, receives 401 without CORS headers, and the script cannot read the response.
      expect(apiCalls.length).toBe(1);
      expect(apiCalls[0].origin).toBe("null");
      expect(apiCalls[0].cookie).toBeUndefined();
      expect(probe.fetchResult.readable).toBe(false);

      // 6. Direct API content URL carries attachment + nosniff + sandbox CSP so it downloads instead of executing.
      const directHeaders = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        http
          .get(`${apiOrigin}/notebooks/nb_1/versions/1/run`, (res) => {
            res.resume();
            resolve(res.headers);
          })
          .on("error", reject);
      });
      expect(directHeaders["content-disposition"]).toContain("attachment");
      expect(directHeaders["x-content-type-options"]).toBe("nosniff");
      expect(directHeaders["content-security-policy"]).toContain("sandbox");
      expect(directExecuted).toBe(false);
    } finally {
      child.kill("SIGKILL");
      frontServer.close();
      apiServer.close();
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }, 30000);
});
