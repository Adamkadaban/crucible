import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@crucible/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@crucible/mcp-server": new URL("./packages/mcp-server/src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    include: ["packages/**/*.live.e2e.test.ts", "packages/**/live.e2e.test.ts"],
    hookTimeout: 20 * 60 * 1000,
    testTimeout: 30 * 60 * 1000,
    fileParallelism: false,
  },
});
