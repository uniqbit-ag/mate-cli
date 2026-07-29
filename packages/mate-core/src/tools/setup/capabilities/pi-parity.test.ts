import { describe, expect, test } from "bun:test";

import { createContextModePlugin } from "./context-mode";
import { createGraphifyPlugin } from "./graphify";
import { createOpenspecPlugin } from "./openspec";
import { createReactDoctorPlugin } from "./react-doctor";
import { createRtkPlugin } from "./rtk";
import { createTokensavePlugin } from "./tokensave";

describe("Pi capability parity", () => {
  test("all provider-specific capabilities expose a Pi integration", () => {
    for (const plugin of [
      createContextModePlugin(),
      createGraphifyPlugin(),
      createOpenspecPlugin(),
      createReactDoctorPlugin(),
      createRtkPlugin(),
      createTokensavePlugin(),
    ]) {
      expect(plugin.forProvider?.pi, plugin.id).toBeDefined();
    }
  });
});
