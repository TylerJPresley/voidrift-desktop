/**
 * The desktop app never offers the host-only `auto_approve` mode (core §2.5,
 * §9.5; cli §2.2). It is a local CLI convenience with a `--auto-approve`
 * entry point; the desktop app has none and never sets
 * `CoreOptions.autoApprove`. This test mocks `@voidrift/core` and the panel
 * registration and asserts the production `bootCore` passes no `autoApprove`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createCoreSpy = vi.fn(async () => ({ api: { register: { panel: vi.fn() } }, housekeeping: {} }));
vi.mock("@voidrift/core", () => ({ createCore: createCoreSpy }));
vi.mock("./builtin-panels.js", () => ({ registerBuiltinPanels: vi.fn() }));
vi.mock("./ipc.js", () => ({ handleInvoke: vi.fn() }));

describe("desktop boot never enables auto_approve (§9.5)", () => {
  beforeEach(() => createCoreSpy.mockClear());

  it("bootCore passes no autoApprove to createCore", async () => {
    const { bootCore } = await import("./core-host.js");
    const broker = { onApproval: vi.fn() } as never;
    await bootCore({ workspaceRoot: "/ws", broker });
    expect(createCoreSpy).toHaveBeenCalledTimes(1);
    const passed = (createCoreSpy.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect("autoApprove" in passed).toBe(false);
    expect(passed["autoApprove"]).toBeUndefined();
    expect(passed["installSignalHandlers"]).toBe(false);
  });

  it("the desktop source never calls session.setMode / never offers vibe (modes are a CLI concern)", async () => {
    // `session.setMode` is the host-only mode control (core §2.7); conversation
    // modes and `Shift+Tab` cycling are a CLI/TUI concern (cli §3.5). The
    // desktop app neither cycles modes nor enters vibe.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    // Scan the whole desktop src tree, not just the main process folder.
    const srcDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir).flatMap((e) => {
        const p = path.join(dir, e);
        return fs.statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = walk(srcDir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\.setMode\s*\(/);
      expect(text, f).not.toMatch(/setMode\s*\(\s*[^,]+,\s*["']vibe["']/);
    }
  });
});
