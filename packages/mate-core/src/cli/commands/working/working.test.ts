import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { resetActiveDistribution, setActiveDistribution } from "../../../distribution";
import { PluginRegistry } from "../../../tools/setup/registry";
import * as cleanup from "./cleanup";
import { runWorkingCommand } from "./working";

beforeEach(() => {
  setActiveDistribution({
    config: { runtime: "bun", version: "test" },
    registry: new PluginRegistry([]),
  });
});

afterEach(() => {
  process.exitCode = 0;
  resetActiveDistribution();
});

describe("runWorkingCommand", () => {
  test("dispatches cleanup", async () => {
    const run = spyOn(cleanup, "runWorkingCleanupCommand").mockImplementation(async () => {});
    try {
      await runWorkingCommand("cleanup", []);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });

  test("rejects unknown subcommands", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await runWorkingCommand("nope", []);
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith("Unknown working command: nope");
    } finally {
      error.mockRestore();
    }
  });
});
