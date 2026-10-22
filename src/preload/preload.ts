/**
 * The preload bridge (desktop-blueprint.md §1.2, §2).
 *
 * This script runs in the isolated preload context (contextIsolation: true) and
 * exposes EXACTLY TWO primitives to the renderer through `contextBridge`:
 *
 *   • `invoke(op, args)`  — forward ONE CoreAPI operation; returns its Result/DTO
 *   • `subscribe(handler)` — register for the scoped EventEnvelope stream
 *
 * Nothing else crosses: `ipcRenderer` is NOT exposed, there is NO generic
 * channel, NO arbitrary-method dispatch, and NO raw Node API. The bridge is the
 * renderer's whole view of the SDK interface (§1.2), which keeps the thin-client
 * boundary structural — the renderer physically cannot call core internals or
 * the filesystem, only the allow-listed CoreAPI surface validated in main (§2).
 *
 * This file is the ONLY one besides `adapters/electron-host.ts` that imports
 * `electron`; it is excluded from the test build and runs only in a real
 * preload context. Its SHAPE (`VoidriftBridge`) is unit-tested through the
 * renderer's `core-client`, which depends on the shape, not on `electron`.
 */
import { contextBridge, ipcRenderer } from "electron";

/** The channel the main process relays scoped event frames on (must match §relay). */
const EVENT_CHANNEL = "voidrift:event";
/** The channel the renderer invokes one op on (request/response). */
const INVOKE_CHANNEL = "voidrift:invoke";

/** The exact two-primitive surface exposed to the renderer (§1.2). */
export interface VoidriftBridge {
  /** Forward one CoreAPI op; main validates against the allow-list (§2). */
  invoke(op: string, args?: readonly unknown[]): Promise<unknown>;
  /** Subscribe to the inert event-frame stream; returns an unsubscribe fn. */
  subscribe(handler: (frame: unknown) => void): () => void;
}

const bridge: VoidriftBridge = {
  invoke(op, args = []) {
    // One structured message; main parses it with Zod before dispatch (§2).
    return ipcRenderer.invoke(INVOKE_CHANNEL, { op, args });
  },
  subscribe(handler) {
    const listener = (_event: unknown, frame: unknown): void => handler(frame);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld("voidrift", bridge);
