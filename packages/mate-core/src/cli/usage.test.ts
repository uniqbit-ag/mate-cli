import { afterEach, beforeEach, expect, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../distribution";
import { PluginRegistry } from "../tools/setup/registry";
import { usage } from "./usage";

beforeEach(() => {
  setActiveDistribution({
    config: { runtime: "bun", version: "test" },
    registry: new PluginRegistry([]),
  });
});

afterEach(() => {
  resetActiveDistribution();
});

test("lists working cleanup", () => {
  expect(usage()).toContain("mate working cleanup");
});
