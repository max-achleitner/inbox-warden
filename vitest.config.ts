import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "scripts/**/__tests__/**/*.test.mjs"],
    exclude: ["src/**/__tests__/integration/**"],
    testTimeout: 10_000,
  },
});
