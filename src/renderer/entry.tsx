/**
 * The renderer entry (desktop-blueprint.md §1.5). A thin shell: resolve the
 * bridge, read the start session id the main process injected, and mount the
 * App. Excluded from coverage — exercised only by a real renderer launch.
 */
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { App } from "./App.js";
import { CoreClient } from "./core-client.js";

function mount(): void {
  const container = document.getElementById("root");
  if (!container) throw new Error("missing #root");
  const client = CoreClient.fromWindow();
  const sessionId = container.dataset["sessionId"] ?? "";
  createRoot(container).render(createElement(App, { client, sessionId }));
}

mount();
