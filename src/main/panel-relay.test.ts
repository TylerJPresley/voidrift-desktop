/**
 * Panel relay round-trip (desktop-blueprint.md §7, panels-blueprint §5).
 *
 * The main process depends on the core, registers its OWN built-in panel
 * declarations (handoff §0.1 — panels ship with the product; no dependency on
 * any plugin), and relays them to the renderer as JSON unchanged. This test
 * registers the product's own declarations through a real core, reads them back
 * from `registry.panels()`, and asserts each serializes to JSON EQUAL to the
 * committed renderer fixture entry — so any drift between the core's
 * `PanelDeclaration` shape and the renderer's local wire type (and its committed
 * fixture) is caught inside this product's own repository.
 */
import { hermeticTmp } from "../test-hermetic.js";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@voidrift/core";
import { BUILTIN_PANELS, registerBuiltinPanels } from "./builtin-panels.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "renderer",
  "fixtures",
  "builtin-panels.json",
);

describe("§7 panel relay — the main process's own declarations serialize to the committed renderer fixture", () => {
  it("every built-in round-trips to JSON equal to the committed fixture entry", async () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    const workspaceRoot = hermeticTmp("desktop-panels");
    const { api } = await createCore({ workspaceRoot });
    try {
      registerBuiltinPanels(api);

      const entries = api.registry.panels();
      const names = entries.map((e) => e.key.slice("panels.".length)).sort();
      // The committed fixture carries exactly the built-in set the core relays.
      expect(new Set(names)).toEqual(new Set(Object.keys(fixture)));
      expect(new Set(names)).toEqual(new Set(Object.keys(BUILTIN_PANELS)));
      for (const entry of entries) {
        const name = entry.key.slice("panels.".length);
        const relayed = JSON.parse(JSON.stringify(entry.value));
        expect(relayed, name).toEqual(fixture[name]);
      }
    } finally {
      await api.session.shutdown();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
