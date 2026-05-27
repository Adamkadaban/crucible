import { describe, expect, it } from "vitest";

import { BOOTSTRAP_TOOLS, getMcpServerBanner } from "./index.js";

describe("MCP server bootstrap surface", () => {
  it("has a server banner", () => {
    expect(getMcpServerBanner()).toContain("crucible MCP server");
  });

  it("declares initial tool names for future registration", () => {
    expect(BOOTSTRAP_TOOLS.map((tool) => tool.name)).toContain("host_check");
  });
});
