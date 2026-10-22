/**
 * The real Electron host adapter (desktop-blueprint.md §1.2, §1.5) — the ONLY
 * file besides the preload that imports the `electron` module. Every
 * main-process logic module depends on the `ElectronHost` seam
 * (`../electron-host.js`), never on `electron` directly, so the logic is
 * unit-testable offline (§11.1). This adapter is excluded from the test build
 * and coverage (vitest.config.ts) and is exercised only in a real Electron
 * runtime — see m6-desktop.md on the real-window test note.
 *
 * The adapter creates the window with the HARDENED web preferences handed to it
 * and asserts their security-critical values at runtime, so a regression fails
 * loudly even outside the type system.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { Entry } from "@napi-rs/keyring";
import type {
  DialogResult,
  ElectronHost,
  HardenedWebPreferences,
  KeychainHost,
  NavigationGuard,
  WindowHandle,
} from "../electron-host.js";

const INVOKE_CHANNEL = "voidrift:invoke";
const KEYCHAIN_SERVICE = "voidrift";

/** Fail fast if any security-critical preference is not the hardened value. */
function assertHardened(prefs: HardenedWebPreferences): void {
  if (
    prefs.contextIsolation !== true ||
    prefs.nodeIntegration !== false ||
    prefs.sandbox !== true ||
    prefs.webSecurity !== true ||
    (prefs.enableRemoteModule as boolean | undefined) === true
  ) {
    throw new Error("refusing to create a window with non-hardened web preferences");
  }
}

const keychain: KeychainHost = {
  async get(key) {
    try {
      return new Entry(KEYCHAIN_SERVICE, key).getPassword() ?? null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    new Entry(KEYCHAIN_SERVICE, key).setPassword(value);
  },
  async delete(key) {
    try {
      new Entry(KEYCHAIN_SERVICE, key).deletePassword();
    } catch {
      /* already absent */
    }
  },
};

/** The real host adapter around the live `electron` API. */
export const electronHost: ElectronHost = {
  createWindow(opts): WindowHandle {
    assertHardened(opts.prefs);
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: true,
      webPreferences: {
        contextIsolation: opts.prefs.contextIsolation,
        nodeIntegration: opts.prefs.nodeIntegration,
        sandbox: opts.prefs.sandbox,
        webSecurity: opts.prefs.webSecurity,
        // SECURITY-F3: propagate the hardened escalation seams explicitly so the
        // adapter's runtime guarantee matches the hardened object exactly.
        enableBlinkFeatures: opts.prefs.enableBlinkFeatures ?? "",
        preload: opts.prefs.preload,
      },
    });

    // SECURITY-F2: deliver the strict CSP on EVERY renderer response, so the
    // structural XSS backstop holds at runtime (not only as a constant). The
    // header is injected via webRequest; the built index.html also carries a
    // <meta> CSP as defense-in-depth.
    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [opts.csp],
        },
      });
    });

    const guard: NavigationGuard = {
      onWillNavigate(decide) {
        win.webContents.on("will-navigate", (event, url) => {
          if (!decide(url)) event.preventDefault();
        });
      },
      onWindowOpen(decide) {
        win.webContents.setWindowOpenHandler(({ url }) => decide(url));
      },
      onPermissionRequest(decide) {
        win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
          callback(decide(permission));
        });
      },
    };
    opts.guard(guard);

    // The single invoke channel. SECURITY-F1: validate the SENDER before the
    // payload reaches intent parsing — the frame must be this window's top
    // (main) frame, not a sub-frame or an injected iframe. The sender's URL is
    // handed to the main-process check (window.ts `isTrustedSender`).
    ipcMain.handle(INVOKE_CHANNEL, (event, payload: unknown) => {
      const senderFrame = event.senderFrame;
      const mainFrame = event.sender.mainFrame;
      const sender = {
        url: senderFrame?.url ?? "",
        isMainFrame: senderFrame != null && senderFrame === mainFrame,
      };
      return opts.onInvoke(payload, sender);
    });

    void win.loadURL(opts.rendererUrl);

    return {
      send: (channel, payload) => win.webContents.send(channel, payload),
      isFocused: () => win.isFocused(),
      close: () => win.close(),
    };
  },

  async showMessageBox(opts): Promise<DialogResult> {
    const result = await dialog.showMessageBox({
      type: opts.type,
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons,
      ...(opts.defaultId !== undefined ? { defaultId: opts.defaultId } : {}),
      ...(opts.cancelId !== undefined ? { cancelId: opts.cancelId } : {}),
    });
    return { response: result.response };
  },

  async openExternal(url): Promise<void> {
    await shell.openExternal(url);
  },

  keychain,

  quit(): void {
    app.quit();
  },
};
