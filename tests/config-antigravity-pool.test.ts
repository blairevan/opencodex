import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../src/types";

describe("antigravityAccountPool config type definition", () => {
  test("preserves valid antigravityAccountPool fields in OcxConfig", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {},
      antigravityAccountPool: {
        enabled: true,
        autoSwitchThreshold: 75,
        strategy: "fill-first",
        stickyLimit: 3,
      },
    };
    expect(config.antigravityAccountPool?.enabled).toBe(true);
    expect(config.antigravityAccountPool?.autoSwitchThreshold).toBe(75);
    expect(config.antigravityAccountPool?.strategy).toBe("fill-first");
    expect(config.antigravityAccountPool?.stickyLimit).toBe(3);
  });
});
