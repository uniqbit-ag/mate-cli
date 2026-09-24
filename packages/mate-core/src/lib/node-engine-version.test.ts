import { describe, expect, test } from "bun:test";

import { enforceableNodeVersion } from "./node-engine-version";

const versions = (extra: Record<string, string>): NodeJS.ProcessVersions =>
  ({ node: "24.3.0", ...extra }) as unknown as NodeJS.ProcessVersions;

describe("the runtime an `engines.node` range may be enforced against", () => {
  test("a real Node process enforces its own version", () => {
    expect(enforceableNodeVersion(versions({}))).toBe("24.3.0");
  });

  test("Bun's compatibility claim is not enforceable", () => {
    expect(enforceableNodeVersion(versions({ bun: "1.3.14" }))).toBeNull();
  });

  test("the CLI's own runtime is Bun, so it enforces nothing", () => {
    expect(enforceableNodeVersion()).toBeNull();
  });
});
