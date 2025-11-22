import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 10,
    testTimeout: 30000,
  },
});

