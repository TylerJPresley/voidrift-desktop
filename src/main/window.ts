/**
 * The hardened window factory and the navigation/permission lockdown
 * (desktop-blueprint.md §1.2, §1 "ELECTRON SECURITY IS THE POINT").
 *
 * This module is PURE: it computes the exact hardened `webPreferences`, the
 * strict CSP header, and the navigation/permission guards, and asks the
 * `ElectronHost` seam to create the window. No `electron` import lives here, so
 * the security posture is unit-testable offline and a test FAILS the moment a
 * pref regresses (§11.1). The real `electron` wiring is in
 * `adapters/electron-host.ts` only.
 */
import type {
  ElectronHost,
  HardenedWebPreferences,
  NavigationGuard,
  WindowHandle,
} from "./electron-host.js";

/**
 * The exact hardened preferences every window uses (§1.2). These are the
 * Electron security-checklist essentials, encoded as literal types so a
 * regression is a compile error AND a test failure:
 *  - contextIsolation: true  — the bridge context is isolated from page script
 *  - nodeIntegration:  false — no Node in the renderer
 *  - sandbox:          true  — the renderer runs in the OS sandbox
 *  - webSecurity:      true  — same-origin + resource rules enforced
 *  - enableRemoteModule: false, enableBlinkFeatures: "" — no escalation seams
 */
export function hardenedWebPreferences(preloadPath: string): HardenedWebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    enableRemoteModule: false,
    enableBlinkFeatures: "",
    preload: preloadPath,
  };
}

/**
 * The strict Content-Security-Policy for the renderer page (§1, §3).
 * `default-src 'none'` denies everything by default; only self scripts/styles
 * and self + data: images are allowed; NO `unsafe-inline`, NO `unsafe-eval`, NO
 * remote origin. This closes script injection structurally alongside React's
 * text-only rendering (§3). A test asserts the string carries no `unsafe-*`.
 */
export const RENDERER_CSP =
  "default-src 'none'; " +
  "script-src 'self'; " +
  "style-src 'self'; " +
  "img-src 'self' data:; " +
  "font-src 'self'; " +
  "connect-src 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

/**
 * The renderer page shell (SECURITY-F2 defense-in-depth). The built index.html
 * carries the SAME strict CSP as the delivered header via a `<meta
 * http-equiv>`, so the policy holds even if a header is ever stripped. The
 * bundle (`renderer.js`) is referenced as a same-origin script, which the CSP
 * `script-src 'self'` admits; there is NO inline script and NO remote origin.
 */
export function renderIndexHtml(csp: string = RENDERER_CSP, bundle = "renderer.js"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="utf-8" />',
    `    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "    <title>VoidRift</title>",
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    `    <script type="module" src="${bundle}"></script>`,
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Assert a CSP string carries none of the unsafe directives (used by §1 test). */
export function cspIsStrict(csp: string): boolean {
  const lower = csp.toLowerCase();
  return (
    lower.includes("default-src 'none'") &&
    !lower.includes("unsafe-inline") &&
    !lower.includes("unsafe-eval") &&
    !lower.includes("http://") &&
    !lower.includes("https://") &&
    !lower.includes("*")
  );
}

/**
 * The second trust layer on renderer → main invokes (SECURITY-F1). An invoke is
 * trusted ONLY when it originates from the window's top (main) frame AND that
 * frame's URL is exactly the renderer URL the main process loaded. A sub-frame,
 * an injected iframe, or a frame on any other origin is refused before the
 * payload reaches intent parsing — nav-deny and the sandbox narrow the surface
 * but do not substitute for this check. The comparison is origin+path exact to
 * defeat a `file://` sibling or a crafted query/hash.
 */
export function isTrustedSender(
  sender: { url: string; isMainFrame: boolean },
  rendererUrl: string,
): boolean {
  if (!sender.isMainFrame) return false;
  let got: URL;
  let want: URL;
  try {
    got = new URL(sender.url);
    want = new URL(rendererUrl);
  } catch {
    return false;
  }
  return got.origin === want.origin && got.pathname === want.pathname;
}

/**
 * Decide whether an external URL may open in the OS browser (§1). Only a
 * well-formed `https:` URL is allowed; every other scheme (`http:`, `file:`,
 * `javascript:`, `data:`, …) is refused. `shell.openExternal` is the ONLY
 * egress and it is gated by this check.
 */
export function isAllowedExternal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}

/**
 * Install the navigation/permission lockdown on a window's guard (§1):
 *  - every in-page navigation is DENIED (`will-navigate` → false)
 *  - every new-window request is DENIED; an https link is handed to the OS
 *    browser via `shell.openExternal`, every other scheme is dropped
 *  - every renderer permission request (camera, geolocation, …) is DENIED
 */
export function installLockdown(host: ElectronHost, guard: NavigationGuard): void {
  guard.onWillNavigate(() => false);
  guard.onWindowOpen((url) => {
    if (isAllowedExternal(url)) {
      void host.openExternal(url);
    }
    return { action: "deny" };
  });
  guard.onPermissionRequest(() => false);
}

/**
 * Create the single hardened main window (§1.2, §1.6 step 3). Builds the
 * hardened prefs, installs the lockdown, hands the adapter the strict CSP to
 * apply to every renderer response (SECURITY-F2), and wraps the invoke handler
 * so a foreign/sub-frame message is refused before it reaches intent parsing
 * (SECURITY-F1). Returns the window handle the event relay sends to.
 */
export function createMainWindow(opts: {
  host: ElectronHost;
  preloadPath: string;
  rendererUrl: string;
  onInvoke: (payload: unknown) => Promise<unknown>;
}): WindowHandle {
  const prefs = hardenedWebPreferences(opts.preloadPath);
  return opts.host.createWindow({
    prefs,
    csp: RENDERER_CSP,
    guard: (nav) => installLockdown(opts.host, nav),
    onInvoke: async (payload, sender) => {
      if (!isTrustedSender(sender, opts.rendererUrl)) {
        return {
          ok: false,
          error: { code: "UNTRUSTED_SENDER", message: "invoke rejected: not the main renderer frame" },
        };
      }
      return opts.onInvoke(payload);
    },
    rendererUrl: opts.rendererUrl,
  });
}
