/**
 * OS-keychain credentials, main-process only (desktop-blueprint.md §7, core §8.4).
 *
 * The desktop app holds MCP/provider secrets in the platform's secure store
 * through the core's `CredentialStore` port. The adapter runs in the MAIN
 * process, never the renderer: a credential value never crosses the IPC bridge,
 * is never rendered, and is masked wherever a record is emitted (core §10.10,
 * invariant §11.2#4). The keychain is reached through the `ElectronHost` seam so
 * this logic is testable offline with no native binding.
 *
 * ── Named CoreAPI gap (reported to the orchestrator) ──
 * `CoreOptions` (core boot.ts) exposes NO `credentialStore` seam: `createCore`
 * always constructs its own `LazyCredentialStore`, which prefers the OS keychain
 * (`@napi-rs/keyring`, the SAME binding this adapter would use) and falls back to
 * the `VOIDRIFT_CREDENTIAL_KEY` encrypted file. The desktop app therefore CANNOT
 * inject its own `CredentialStore` as the blueprint §7/§1.1 states; the core's
 * built-in keychain selection already satisfies the keychain-first requirement.
 * This `KeychainCredentials` implements the exact `CredentialStore` port shape so
 * the app is ready the instant the core adds the seam, and backs any app-owned
 * secret meanwhile. The keychain-in-main invariant (§11.2#4) holds either way:
 * the store only ever lives in this process.
 *
 * Second part of the same gap: the `CredentialStore` PORT TYPE is not exported
 * from `@voidrift/core`'s index (core §8.4 names it but index.ts omits it), so a
 * consumer cannot `import type { CredentialStore }`. The structural shape is
 * declared locally here to match it exactly.
 */
import type { KeychainHost } from "./electron-host.js";

/** The `CredentialStore` port shape (core §8.4) — mirrored locally; see note. */
export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The OS-keychain `CredentialStore` the app owns in the main process (§7). */
export class KeychainCredentials implements CredentialStore {
  constructor(private readonly keychain: KeychainHost) {}

  get(key: string): Promise<string | null> {
    return this.keychain.get(key);
  }

  set(key: string, value: string): Promise<void> {
    return this.keychain.set(key, value);
  }

  delete(key: string): Promise<void> {
    return this.keychain.delete(key);
  }
}
