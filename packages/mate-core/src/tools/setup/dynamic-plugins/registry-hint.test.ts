import { describe, expect, test } from "bun:test";

import { registryConfigHint } from "./registry-hint";

describe("registryConfigHint", () => {
  test("names the scope for a scoped package, without guessing the registry URL", () => {
    const hint = registryConfigHint("@acme/custom-plugin");
    expect(hint).toContain("@acme");
    expect(hint).toContain("npm config set");
    expect(hint).not.toContain("registry.npmjs.org");
  });

  test("stays generic for an unscoped package", () => {
    const hint = registryConfigHint("plain-tool");
    expect(hint).not.toContain('npm config set "');
  });
});
