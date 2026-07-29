import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { runReportCommand } from "./index";

const COMPANION_PATH = "/tmp/test-companion";

beforeEach(async () => {
  await fs.mkdir(COMPANION_PATH, { recursive: true });
});

const makeResolveContext = () => ({
  configStore: {
    load: async () => ({
      capabilities: [{ name: "tokensave" }, { name: "headroom" }],
    }),
  },
  workingRepoStore: {
    load: async () => ({
      repos: [{ id: "test", path: "/tmp/test-work", profile: "default" }],
    }),
  },
  companionPath: "/tmp/test-companion",
});

const makeSpawn =
  (stdout: string, status = 0) =>
  () =>
    ({ stdout, status, error: null }) as ReturnType<typeof spawnSync>;

const makeDelivery = () => ({
  writeTemporaryReport: async () => "/tmp/mate-report/report.html",
  openReportInBrowser: async () => {},
});

describe("runReportCommand", () => {
  test("does not invoke RTK savings when RTK is disabled", async () => {
    const calls: string[][] = [];
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      ...makeDelivery(),
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return {
          stdout: JSON.stringify({ daily: [{ modelBreakdowns: [] }] }),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      },
    };

    await runReportCommand([], deps);

    expect(calls.some((args) => args[0] === "rtk")).toBe(false);
  });

  test("generates report with mocked dependencies", async () => {
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      ...makeDelivery(),
      spawn: makeSpawn(
        JSON.stringify({
          daily: [
            {
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-5",
                  cost: 1.0,
                  inputTokens: 1000,
                  outputTokens: 500,
                  cacheReadTokens: 800,
                  cacheCreationTokens: 0,
                },
              ],
            },
          ],
        }),
      ),
    };
    await runReportCommand([], deps);
    // Command should complete without throwing
  });

  test("supports --json flag", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      writeTemporaryReport: async () => {
        throw new Error("JSON mode must not write HTML");
      },
      openReportInBrowser: async () => {
        throw new Error("JSON mode must not open a browser");
      },
      spawn: makeSpawn(
        JSON.stringify({
          daily: [{ modelBreakdowns: [] }],
        }),
      ),
    };
    await runReportCommand(["--json"], deps);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toThrow();
    logSpy.mockRestore();
  });

  test("supports --days flag", async () => {
    const deps = {
      resolveFrameworkContext: makeResolveContext,
      ...makeDelivery(),
      spawn: makeSpawn(
        JSON.stringify({
          daily: [{ modelBreakdowns: [] }],
        }),
      ),
    };
    await runReportCommand(["--days", "30"], deps);
    // Command should complete without throwing
  });

  test("handles all tools disabled gracefully", async () => {
    const deps = {
      resolveFrameworkContext: () => ({
        configStore: { load: async () => ({ capabilities: [] }) },
        workingRepoStore: {
          load: async () => ({
            repos: [{ id: "test", path: "/tmp/test-work", profile: "default" }],
          }),
        },
        companionPath: "/tmp/test-companion",
      }),
      ...makeDelivery(),
      spawn: makeSpawn("", 1),
    };
    await runReportCommand([], deps);
    // Command should complete without throwing
  });

  test("falls back to JSON when temporary HTML creation fails", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    await runReportCommand([], {
      resolveFrameworkContext: makeResolveContext,
      writeTemporaryReport: async () => {
        throw new Error("disk full");
      },
      spawn: makeSpawn(""),
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toThrow();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("falls back to JSON and reports the path when browser launch fails", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const reportPath = "/tmp/mate-report/report.html";

    await runReportCommand([], {
      resolveFrameworkContext: makeResolveContext,
      writeTemporaryReport: async () => reportPath,
      openReportInBrowser: async () => {
        throw new Error("browser unavailable");
      },
      spawn: makeSpawn(""),
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(reportPath));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("browser unavailable"));
    expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toThrow();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("does not modify an existing REPORT.md", async () => {
    const reportPath = `${COMPANION_PATH}/REPORT.md`;
    await fs.writeFile(reportPath, "keep this report");

    await runReportCommand([], {
      resolveFrameworkContext: makeResolveContext,
      ...makeDelivery(),
      spawn: makeSpawn(""),
    });

    expect(await fs.readFile(reportPath, "utf8")).toBe("keep this report");
  });
});
