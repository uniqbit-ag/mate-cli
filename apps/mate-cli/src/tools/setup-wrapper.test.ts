import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import setup, { setupToolDeps } from "./setup";

const originalExecuteSetup = setupToolDeps.executeSetup;

beforeEach(() => {
  setupToolDeps.executeSetup = mock(async () => ({
    config: {
      profiles: { default: { name: "default", allowedAgents: ["claude"] } },
    },
  }));
});

afterEach(() => {
  setupToolDeps.executeSetup = originalExecuteSetup;
  mock.restore();
});

describe("setup tool wrapper", () => {
  test("delegates execution to executeSetup", async () => {
    const input = { allowedAgents: ["opencode"] };

    const result = await setup.execute(input);

    expect(setupToolDeps.executeSetup).toHaveBeenCalledWith(input);
    expect(result.config.profiles.default.allowedAgents).toEqual(["claude"]);
  });
});
