import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@crucible/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@crucible/mcp-server": fileURLToPath(
        new URL("./packages/mcp-server/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/*.live.e2e.test.ts", "packages/**/live.e2e.test.ts"],
    hookTimeout: 20 * 60 * 1000,
    testTimeout: 30 * 60 * 1000,
    fileParallelism: false,
  },
});
