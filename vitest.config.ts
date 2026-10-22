import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts", "./src/test-hermetic.ts"],
    globalSetup: ["./src/test-hermetic.global.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/test-hermetic.global.ts",
        "src/test-hermetic.ts",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/test-setup.ts",
        "src/test-harness.ts",
        // The ONLY file that imports `electron`; exercised only in a real
        // Electron runtime, never offline (desktop-blueprint §1.5, §11.1).
        "src/main/adapters/electron-host.ts",
        // Type-only seam interface (no runtime), like web-client's wire.ts.
        "src/main/electron-host.ts",
        "src/preload/preload.ts",
        // Process entry shells — thin wiring exercised only by a real launch.
        "src/main/main.ts",
        "src/renderer/entry.tsx",
      ],
      thresholds: { statements: 80, branches: 70, functions: 80, lines: 80 },
    },
  },
});
