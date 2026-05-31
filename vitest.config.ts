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
    include: ["packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      include: ["packages/{cli,core,mcp-server}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.live.test.ts"],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
});
