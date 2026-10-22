/**
 * The scripted-core + fake-ElectronHost test harness (desktop-blueprint §11.1).
 *
 * Every integration test runs against a REAL `createCore` driven by a
 * `fakeModel` with in-memory session storage (deterministic, offline), and a
 * FAKE `ElectronHost` that records window creation (with its web preferences),
 * dialogs, external-open attempts, and keychain access so a test can assert on
 * them. No real Electron binary is required — the `electron` module is behind
 * the seam (§1.2, §11.1).
 */
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import type { Config, CoreReady } from "@voidrift/core";
import { createCore, InMemoryConfigStore } from "@voidrift/core";
import { hermeticTmp } from "./test-hermetic.js";
import type {
  DialogResult,
  ElectronHost,
  HardenedWebPreferences,
  InvokeSender,
  KeychainHost,
  NavigationGuard,
  WindowHandle,
} from "./main/electron-host.js";

const DEFAULT_SEED: Partial<Config> = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

/** A recording of everything the main process did to the fake host. */
export interface HostRecorder {
  windows: Array<{
    prefs: HardenedWebPreferences;
    rendererUrl: string;
    csp: string;
    guard: GuardProbe;
    onInvoke: (payload: unknown, sender: InvokeSender) => Promise<unknown>;
    handle: WindowHandle;
  }>;
  sent: Array<{ channel: string; payload: unknown }>;
  dialogs: Array<{ type: string; message: string; detail: string; buttons: string[] }>;
  externalOpens: string[];
  keychainSets: Array<{ key: string; value: string }>;
  keychainGets: string[];
  quit: boolean;
}

export interface FakeHostOptions {
  /** Scripted dialog answers (button index), consumed in order. */
  dialogAnswers?: number[];
  /** A seed keychain map. */
  keychainSeed?: Record<string, string>;
}

export interface FakeElectronHost extends ElectronHost {
  rec: HostRecorder;
}

/** Build a fake `ElectronHost` that records interactions and replays scripts. */
export function makeFakeHost(opts: FakeHostOptions = {}): FakeElectronHost {
  const rec: HostRecorder = {
    windows: [],
    sent: [],
    dialogs: [],
    externalOpens: [],
    keychainSets: [],
    keychainGets: [],
    quit: false,
  };
  const dialogAnswers = [...(opts.dialogAnswers ?? [])];
  const store = new Map<string, string>(Object.entries(opts.keychainSeed ?? {}));

  const keychain: KeychainHost = {
    async get(key) {
      rec.keychainGets.push(key);
      return store.get(key) ?? null;
    },
    async set(key, value) {
      rec.keychainSets.push({ key, value });
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };

  const host: FakeElectronHost = {
    rec,
    createWindow(createOpts): WindowHandle {
      const handle: WindowHandle = {
        send: (channel, payload) => rec.sent.push({ channel, payload }),
        isFocused: () => true,
        close: () => {},
      };
      // Capture the guard the window installs so a test can exercise it.
      let captured!: GuardProbe;
      createOpts.guard(makeGuardProbe((g) => (captured = g)));
      rec.windows.push({
        prefs: createOpts.prefs,
        rendererUrl: createOpts.rendererUrl,
        csp: createOpts.csp,
        guard: captured,
        onInvoke: createOpts.onInvoke,
        handle,
      });
      return handle;
    },
    async showMessageBox(boxOpts): Promise<DialogResult> {
      rec.dialogs.push({ type: boxOpts.type, message: boxOpts.message, detail: boxOpts.detail, buttons: boxOpts.buttons });
      return { response: dialogAnswers.length > 0 ? dialogAnswers.shift()! : 0 };
    },
    async openExternal(url): Promise<void> {
      rec.externalOpens.push(url);
    },
    keychain,
    quit(): void {
      rec.quit = true;
    },
  };
  return host;
}

/**
 * A probe `NavigationGuard` that captures the decide callbacks the lockdown
 * installs, so a test can call them directly and assert the deny decisions.
 */
export interface GuardProbe extends NavigationGuard {
  willNavigate(url: string): boolean;
  windowOpen(url: string): { action: "deny" | "allow" };
  permissionRequest(permission: string): boolean;
}

function makeGuardProbe(onReady: (g: GuardProbe) => void): GuardProbe {
  let willNavigate: (url: string) => boolean = () => true;
  let windowOpen: (url: string) => { action: "deny" | "allow" } = () => ({ action: "allow" });
  let permissionRequest: (permission: string) => boolean = () => true;
  const probe: GuardProbe = {
    onWillNavigate: (d) => (willNavigate = d),
    onWindowOpen: (d) => (windowOpen = d),
    onPermissionRequest: (d) => (permissionRequest = d),
    willNavigate: (url) => willNavigate(url),
    windowOpen: (url) => windowOpen(url),
    permissionRequest: (p) => permissionRequest(p),
  };
  onReady(probe);
  return probe;
}

/** Build a scripted core for an integration test (fakeModel + in-memory). */
export async function makeCore(opts: { reply?: string; seed?: Partial<Config> } = {}): Promise<CoreReady> {
  const reply = opts.reply ?? "ok";
  const factory = (): ReturnType<typeof fakeModel> => fakeModel().respond(new AIMessage(reply));
  return createCore({
    workspaceRoot: hermeticTmp("desktop"),
    // Injected config store keeps the harness isolated from first-run global
    // seeding (§13.9.1), which runs only for the production default store.
    configStore: new InMemoryConfigStore({ ...DEFAULT_SEED, ...(opts.seed ?? {}) }),
    chatModelFactory: factory,
    installSignalHandlers: false,
  });
}

/** Register and emit a core event with an optional session scope (for tests). */
export function emitEvent(ready: CoreReady, type: string, payload: unknown, sessionId?: string): void {
  ready.api.events.register(type);
  ready.api.events.emit(type, payload, sessionId ? { session: sessionId } : {});
}
