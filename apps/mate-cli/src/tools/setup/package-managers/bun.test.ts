import { describe, expect, test } from "bun:test";

import { bunPlugin } from "./bun";

describe("bunPlugin", () => {
  test("is enabled by default when packageManagers is absent", () => {
    expect(
      bunPlugin.isEnabled({
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [],
      }),
    ).toBe(true);
  });

  test("is disabled when bun is not selected", () => {
    expect(
      bunPlugin.isEnabled({
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        packageManagers: ["uv"],
        capabilities: [],
      }),
    ).toBe(false);
  });

  test("apply and teardown are no-op promises", async () => {
    await expect(bunPlugin.apply({} as never)).resolves.toBeUndefined();
    await expect(bunPlugin.teardown({} as never)).resolves.toBeUndefined();
  });
});
