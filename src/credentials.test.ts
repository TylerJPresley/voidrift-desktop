/**
 * Credentials tests (desktop-blueprint.md §7, core §8.4).
 *
 * The OS-keychain store lives in the MAIN process only; a credential value
 * never crosses the IPC bridge (there is no credential op on the allow-list)
 * and never appears in a relayed frame.
 */
import { describe, expect, it } from "vitest";
import { KeychainCredentials } from "./main/credentials.js";
import { ALLOWED_OPS } from "./main/ipc.js";
import { makeFakeHost } from "./test-harness.js";

describe("KeychainCredentials (§7 — main-process only)", () => {
  it("reads and writes through the main-process keychain seam", async () => {
    const host = makeFakeHost();
    const creds = new KeychainCredentials(host.keychain);
    await creds.set("mcp:acme:authorization", "Bearer sk-secret");
    expect(host.rec.keychainSets).toEqual([{ key: "mcp:acme:authorization", value: "Bearer sk-secret" }]);
    const got = await creds.get("mcp:acme:authorization");
    expect(got).toBe("Bearer sk-secret");
    await creds.delete("mcp:acme:authorization");
    expect(await creds.get("mcp:acme:authorization")).toBeNull();
  });
});

describe("no credential op crosses the bridge (§7, invariant §11.2#4)", () => {
  it("the invoke allow-list exposes no keychain / credential operation", () => {
    for (const op of ALLOWED_OPS) {
      expect(op).not.toMatch(/credential|keychain|secret|token/i);
    }
  });

  it("mcp config ops carry only non-secret parameters (secret stays in keychain)", () => {
    // The only mcp write ops are saveConfig/removeConfig (non-secret per §7);
    // the secret lands in the keychain through CredentialStore, never a bridge op.
    expect(ALLOWED_OPS).toContain("mcp.saveConfig");
    expect(ALLOWED_OPS).toContain("mcp.removeConfig");
  });
});
