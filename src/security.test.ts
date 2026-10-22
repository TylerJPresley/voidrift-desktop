/**
 * Security tests (desktop-blueprint.md §1, §1.2, §1.6).
 *
 * These are the tests that FAIL if a security pref regresses: the hardened
 * webPreferences, the strict CSP, the two-primitive bridge, and the
 * navigation/permission/external-open lockdown.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RENDERER_CSP,
  cspIsStrict,
  createMainWindow,
  hardenedWebPreferences,
  installLockdown,
  isAllowedExternal,
  isTrustedSender,
  renderIndexHtml,
} from "./main/window.js";
import { makeFakeHost } from "./test-harness.js";
import { ALLOWED_OPS } from "./main/ipc.js";
import type { NavigationGuard } from "./main/electron-host.js";

describe("hardened webPreferences (§1.2)", () => {
  // Given the window factory
  // When a window is created
  // Then the EXACT hardened security preferences are used — this test FAILS if
  // contextIsolation/sandbox/nodeIntegration (or webSecurity/remote) regress.
  it("creates the window with the exact hardened preferences", () => {
    const host = makeFakeHost();
    createMainWindow({ host, preloadPath: "/app/preload.js", rendererUrl: "file:///app/index.html", onInvoke: async () => ({}) });
    const prefs = host.rec.windows[0]!.prefs;
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.enableRemoteModule).toBe(false);
    expect(prefs.enableBlinkFeatures).toBe("");
    expect(prefs.preload).toBe("/app/preload.js");
  });

  it("the hardened prefs object has no loosened value", () => {
    const prefs = hardenedWebPreferences("/p.js");
    // A regression (e.g. nodeIntegration flipped to true) is caught here too.
    expect(Object.values(prefs)).not.toContain(undefined);
    expect(prefs.nodeIntegration).not.toBe(true);
    expect(prefs.contextIsolation).not.toBe(false);
  });
});

describe("strict CSP (§1, §3)", () => {
  it("the renderer CSP denies by default and carries no unsafe directive", () => {
    expect(RENDERER_CSP).toContain("default-src 'none'");
    expect(RENDERER_CSP).not.toMatch(/unsafe-inline/i);
    expect(RENDERER_CSP).not.toMatch(/unsafe-eval/i);
    expect(RENDERER_CSP).not.toMatch(/https?:\/\//i);
    expect(cspIsStrict(RENDERER_CSP)).toBe(true);
  });

  it("cspIsStrict rejects an unsafe policy", () => {
    expect(cspIsStrict("default-src 'self' 'unsafe-inline'")).toBe(false);
    expect(cspIsStrict("script-src 'unsafe-eval'")).toBe(false);
    expect(cspIsStrict("default-src https://evil.example")).toBe(false);
  });
});

describe("navigation / permission / external lockdown (§1)", () => {
  it("denies every in-page navigation and every new window", () => {
    const host = makeFakeHost();
    let guard!: NavigationGuard & {
      willNavigate(u: string): boolean;
      windowOpen(u: string): { action: string };
      permissionRequest(p: string): boolean;
    };
    installLockdown(host, makeProbe((g) => (guard = g)));
    expect(guard.willNavigate("https://evil.example")).toBe(false);
    expect(guard.windowOpen("https://evil.example").action).toBe("deny");
    expect(guard.permissionRequest("geolocation")).toBe(false);
  });

  it("opens only an https external link via the OS browser; refuses other schemes", () => {
    const host = makeFakeHost();
    let guard!: ReturnType<typeof makeProbeGuard>;
    installLockdown(host, makeProbe((g) => (guard = g)));
    guard.windowOpen("https://docs.example.com");
    guard.windowOpen("http://insecure.example");
    guard.windowOpen("file:///etc/passwd");
    guard.windowOpen("javascript:alert(1)");
    expect(host.rec.externalOpens).toEqual(["https://docs.example.com"]);
  });

  it("isAllowedExternal accepts only well-formed https", () => {
    expect(isAllowedExternal("https://ok.example")).toBe(true);
    expect(isAllowedExternal("http://no.example")).toBe(false);
    expect(isAllowedExternal("file:///x")).toBe(false);
    expect(isAllowedExternal("not a url")).toBe(false);
  });
});

describe("op allow-list surface (§2)", () => {
  it("exposes no register, no events, no internal op", () => {
    for (const op of ALLOWED_OPS) {
      expect(op.startsWith("register.")).toBe(false);
      expect(op.startsWith("events.")).toBe(false);
      expect(op).not.toContain("internal");
    }
  });
});

describe("sender validation on invoke (§2, SECURITY-F1)", () => {
  const RENDERER = "file:///app/index.html";

  // Given a window wired by createMainWindow
  // When an invoke arrives from the top (main) frame on the renderer URL
  // Then it reaches the business handler; a sub-frame or foreign origin is refused.
  function wire(): ReturnType<typeof makeFakeHost> {
    const host = makeFakeHost();
    createMainWindow({
      host,
      preloadPath: "/app/preload.js",
      rendererUrl: RENDERER,
      onInvoke: async () => ({ ok: true, value: "reached-core" }),
    });
    return host;
  }

  it("accepts an invoke from the trusted main frame on the renderer URL", async () => {
    const host = wire();
    const res = (await host.rec.windows[0]!.onInvoke(
      { op: "session.list", args: [] },
      { url: RENDERER, isMainFrame: true },
    )) as { ok: boolean; value?: string };
    expect(res.value).toBe("reached-core");
  });

  it("refuses an invoke from a non-main (sub) frame — never reaches core", async () => {
    const host = wire();
    const res = (await host.rec.windows[0]!.onInvoke(
      { op: "session.list", args: [] },
      { url: RENDERER, isMainFrame: false },
    )) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("UNTRUSTED_SENDER");
  });

  it("refuses an invoke from a foreign origin even if it claims main frame", async () => {
    const host = wire();
    const res = (await host.rec.windows[0]!.onInvoke(
      { op: "session.list", args: [] },
      { url: "https://evil.example/index.html", isMainFrame: true },
    )) as { ok: boolean; error: { code: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("UNTRUSTED_SENDER");
  });

  it("isTrustedSender: only the exact main-frame renderer URL passes", () => {
    expect(isTrustedSender({ url: RENDERER, isMainFrame: true }, RENDERER)).toBe(true);
    expect(isTrustedSender({ url: RENDERER, isMainFrame: false }, RENDERER)).toBe(false);
    expect(isTrustedSender({ url: "file:///app/evil.html", isMainFrame: true }, RENDERER)).toBe(false);
    expect(isTrustedSender({ url: "https://x.example/index.html", isMainFrame: true }, RENDERER)).toBe(false);
    expect(isTrustedSender({ url: "not a url", isMainFrame: true }, RENDERER)).toBe(false);
  });
});

describe("CSP delivery (§1, §3, SECURITY-F2)", () => {
  // Given the window factory
  // When a window is created
  // Then the strict CSP is handed to the adapter for header delivery, and the
  // built index.html carries the SAME policy in a <meta> as defense-in-depth.
  it("hands the strict CSP to the adapter for every window", () => {
    const host = makeFakeHost();
    createMainWindow({ host, preloadPath: "/p.js", rendererUrl: "file:///app/index.html", onInvoke: async () => ({}) });
    const csp = host.rec.windows[0]!.csp;
    expect(csp).toBe(RENDERER_CSP);
    expect(cspIsStrict(csp)).toBe(true);
  });

  it("the index.html shell carries the same strict CSP meta and no inline script", () => {
    const html = renderIndexHtml();
    expect(html).toContain(`content="${RENDERER_CSP}"`);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    // The only script is a same-origin module reference — no inline code.
    expect(html).toMatch(/<script type="module" src="renderer\.js"><\/script>/);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // no inline script body
  });

  it("the committed renderer index.html matches the helper (no CSP drift)", () => {
    const onDisk = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "renderer/index.html"),
      "utf8",
    );
    expect(onDisk).toBe(renderIndexHtml());
  });
});

describe("hardened pref propagation (§1.2, SECURITY-F3)", () => {
  it("the hardened prefs carry the escalation seams the adapter propagates", () => {
    // The adapter spreads enableBlinkFeatures from this object; a regression to
    // a non-empty value would open an experimental Blink seam to page content.
    const prefs = hardenedWebPreferences("/p.js");
    expect(prefs.enableBlinkFeatures).toBe("");
    expect(prefs.enableRemoteModule).toBe(false);
  });
});

// ── probe helpers ──
interface ProbeGuard extends NavigationGuard {
  willNavigate(url: string): boolean;
  windowOpen(url: string): { action: "deny" | "allow" };
  permissionRequest(permission: string): boolean;
}
function makeProbeGuard(): ProbeGuard {
  let wn: (u: string) => boolean = () => true;
  let wo: (u: string) => { action: "deny" | "allow" } = () => ({ action: "allow" });
  let pr: (p: string) => boolean = () => true;
  return {
    onWillNavigate: (d) => (wn = d),
    onWindowOpen: (d) => (wo = d),
    onPermissionRequest: (d) => (pr = d),
    willNavigate: (u) => wn(u),
    windowOpen: (u) => wo(u),
    permissionRequest: (p) => pr(p),
  };
}
function makeProbe(onReady: (g: ProbeGuard) => void): ProbeGuard {
  const g = makeProbeGuard();
  onReady(g);
  return g;
}
