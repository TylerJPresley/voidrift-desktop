/**
 * The app lifecycle entry (desktop-blueprint.md §1.6). A thin shell wiring the
 * seam-driven pieces together; excluded from coverage — exercised only by a
 * real Electron launch. All testable logic lives behind the `ElectronHost` seam
 * in `window.ts`, `ipc.ts`, `event-relay.ts`, `approvals.ts`, and `core-host.ts`.
 */
import { app } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CoreReady } from "@voidrift/core";
import { electronHost } from "./adapters/electron-host.js";
import { ApprovalBroker } from "./approvals.js";
import { bootCore, makeInvokeHandler, resolveStart } from "./core-host.js";
import { createMainWindow } from "./window.js";
import { relayHost, relaySession } from "./event-relay.js";
import { APPROVAL_EVENT } from "./approvals.js";
import { EVENT_CHANNEL } from "./event-relay.js";

const here = path.dirname(fileURLToPath(import.meta.url));

async function start(): Promise<void> {
  await app.whenReady();
  const workspaceRoot = process.cwd();

  let ready: CoreReady;
  const broker = new ApprovalBroker({
    present: (req) => window?.send(EVENT_CHANNEL, { type: APPROVAL_EVENT, scope: "host", at: new Date().toISOString(), payload: req }),
  });

  let window: ReturnType<typeof createMainWindow> | undefined;
  try {
    ready = await bootCore({ workspaceRoot, broker });
  } catch (e) {
    await electronHost.showMessageBox({
      type: "error",
      message: "VoidRift could not start",
      detail: e instanceof Error ? e.message : String(e),
      buttons: ["Quit"],
    });
    app.quit();
    return;
  }

  const preloadPath = path.join(here, "..", "preload", "preload.js");
  const rendererUrl = pathToFileURL(path.join(here, "..", "renderer", "index.html")).toString();
  window = createMainWindow({
    host: electronHost,
    preloadPath,
    rendererUrl,
    onInvoke: makeInvokeHandler(ready.api, broker),
  });

  relayHost(ready.api, window);
  const start = await resolveStart(ready.api, { kind: "open" }, 1);
  if ("session" in start) relaySession(ready.api, window, start.session.id);

  app.on("before-quit", () => {
    void ready.api.session.shutdown();
  });
}

void start();
