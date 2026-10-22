/**
 * The Electron host seam (desktop-blueprint.md §1.2, §1.5, §11.1).
 *
 * Every real `electron` capability the main process touches is funnelled
 * through this one interface, so all main-process logic depends on the seam —
 * never on the `electron` module directly. The real adapter
 * (`adapters/electron-host.ts`) is the ONLY file that imports `electron`; tests
 * supply an in-memory fake. This keeps intent validation, core-client wiring,
 * approvals, and the event relay unit-testable offline with no Electron binary
 * (§11.1), exactly like the VS Code extension's `VSCodeHost`.
 *
 * The surface is intentionally narrow: window creation with the HARDENED web
 * preferences (§1.2), native dialogs for approvals and construction errors
 * (§6, §1.6), the OS keychain (§7, main-process only), and the renderer channel
 * the preload bridge rides on (`send` to the renderer, `handle` for one invoke).
 */

/**
 * The exact hardened `BrowserWindow` web preferences the main process MUST use
 * (desktop-blueprint §1.2; the Electron security-checklist essentials). A test
 * asserts these values and FAILS if any security pref regresses (§1.6).
 */
export interface HardenedWebPreferences {
  /** Isolate the preload/bridge context from page scripts. MUST be true. */
  readonly contextIsolation: true;
  /** No Node in the renderer. MUST be false. */
  readonly nodeIntegration: false;
  /** Run the renderer in the OS sandbox. MUST be true. */
  readonly sandbox: true;
  /** Same-origin + resource rules on. MUST be true. */
  readonly webSecurity: true;
  /** No `remote` module bridge. MUST be false. */
  readonly enableRemoteModule?: false;
  /** No experimental Blink features opened to page content. MUST be undefined/empty. */
  readonly enableBlinkFeatures?: "";
  /** The preload that installs the two-primitive bridge (an absolute path). */
  readonly preload: string;
}

/** A window the main process opens; it loads the renderer and hosts the bridge. */
export interface WindowHandle {
  /** Relay one `EventEnvelope` frame to this window's renderer (main → renderer). */
  send(channel: string, payload: unknown): void;
  /** Is this the focused window? Approvals route to the focused window (§6.1). */
  isFocused(): boolean;
  /** Close the window. */
  close(): void;
}

/** A navigation attempt the main process decides on (§1 navigation lockdown). */
export interface NavigationGuard {
  /** `will-navigate` → deny every navigation (return false denies). */
  onWillNavigate(decide: (url: string) => boolean): void;
  /** `setWindowOpenHandler` → deny every new window; external links go via shell. */
  onWindowOpen(decide: (url: string) => { action: "deny" | "allow" }): void;
  /** A `session.setPermissionRequestHandler` that denies by default (§1). */
  onPermissionRequest(decide: (permission: string) => boolean): void;
}

/**
 * The origin of the frame that sent an invoke, for the second trust layer (§2,
 * SECURITY-F1). The adapter fills this from `event.senderFrame`; main refuses an
 * invoke whose frame is not the window's top (main) frame on the renderer URL.
 */
export interface InvokeSender {
  /** The sending frame's URL (`event.senderFrame.url`). */
  readonly url: string;
  /** Whether the sending frame is the window's top frame (`=== mainFrame`). */
  readonly isMainFrame: boolean;
}

/**
 * The injected renderer invoke channel (preload `invoke` → main handler). The
 * adapter passes the validated `sender`; a foreign/sub-frame invoke is rejected
 * BEFORE the payload reaches intent parsing (defense in depth over nav-deny +
 * sandbox, SECURITY-F1).
 */
export type InvokeHandler = (payload: unknown, sender: InvokeSender) => Promise<unknown>;

/** A modal native dialog's answer, by button index (§6.1, §1.6). */
export interface DialogResult {
  /** The index of the clicked button in the `buttons` array. */
  response: number;
}

/**
 * The seam. Every method wraps a real Electron capability the adapter provides;
 * the main-process logic calls only these, never `electron` directly.
 */
export interface ElectronHost {
  /**
   * Create the main window with the HARDENED web preferences, register the
   * navigation/permission guards, load the renderer, and wire the single invoke
   * channel to `onInvoke`. The returned handle relays events to the renderer.
   * The adapter asserts the preferences it was handed are the hardened set.
   */
  createWindow(opts: {
    prefs: HardenedWebPreferences;
    guard: (nav: NavigationGuard) => void;
    onInvoke: InvokeHandler;
    /**
     * The strict Content-Security-Policy the adapter MUST apply to every
     * renderer response (via `session.webRequest.onHeadersReceived`), so the
     * CSP backstop holds at runtime and not only as a constant (SECURITY-F2).
     */
    csp: string;
    /** The renderer entry (a `file://` the app controls) or dev URL. */
    rendererUrl: string;
  }): WindowHandle;

  /** Show a native modal (approvals that are not inline, construction errors). */
  showMessageBox(opts: {
    type: "info" | "warning" | "error" | "question";
    message: string;
    detail: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
  }): Promise<DialogResult>;

  /** Open an external https URL in the OS browser — the ONLY egress (§1). */
  openExternal(url: string): Promise<void>;

  /** The OS keychain, accessed ONLY in the main process (§7). */
  keychain: KeychainHost;

  /** Quit the application (after `session.shutdown()` resolves, §1.6). */
  quit(): void;
}

/**
 * The OS keychain surface (desktop-blueprint §7, core §8.4). It runs in the
 * main process ONLY; a credential value NEVER crosses the IPC bridge, is never
 * rendered, and is masked wherever a record is emitted (core §10.10). The real
 * adapter wraps `@napi-rs/keyring` (MIT, the same binding core ships).
 */
export interface KeychainHost {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
