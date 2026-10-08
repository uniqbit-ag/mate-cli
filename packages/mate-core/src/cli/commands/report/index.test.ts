import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { runReportCommand } from "./index";
import { REPORT_DOCUMENT_VERSION } from "./types";

const COMPANION_PATH = "/tmp/test-companion";
const REPORT_NOW = new Date("2026-08-31T12:00:00Z");

beforeEach(async () => {
  await fs.mkdir(COMPANION_PATH, { recursive: true });
});

const makeResolveContext = () => ({
  configStore: {
    load: async () => ({
      capabilities: [{ name: "tokensave" }, { name: "graphify" }],
    }),
  },
  workingRepoStore: {
    load: async () => ({
      repos: [{ id: "test", path: "/tmp/test-work" }],
    }),
  },
  companionPath: "/tmp/test-companion",
});

const makeSpawn =
  (stdout: string, status = 0) =>
  () =>
    ({ stdout, status, error: null }) as ReturnType<typeof spawnSync>;

const makeDelivery = () => ({
  publishReportToStudio: async () => null,
  writeTemporaryReport: async () => "/tmp/mate-report/report.html",
  openReportInBrowser: async () => {},
});

describe("runReportCommand", () => {
  const structuredDocument = JSON.stringify({
    version: REPORT_DOCUMENT_VERSION,
    title: "Structured report",
    generatedAt: "2026-01-01T00:00:00Z",
    metadata: [{ label: "Owner", value: "acme" }],
    summary: [{ label: "Count", value: 1 }],
    sections: [{ id: "notes", title: "Notes", type: "text", content: "Supplied" }],
  });

  test("accepts structured JSON from a file input and preserves JSON mode", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const spawn = () => {
      throw new Error("structured input must not run collectors");
    };
    await runReportCommand(["--input", "report.json", "--json"], {
      ensureUnambiguousCompanion: async () => true,
      readInput: async (input) => {
        expect(input).toBe("report.json");
        return structuredDocument;
      },
      spawn,
    });
    const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(parsed.title).toBe("Structured report");
    expect(parsed.sections[0].type).toBe("text");
    logSpy.mockRestore();
  });

  test("rejects invalid structured input without opening a report", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    /**
     * Recorded rather than thrown: a throwing delivery dep is swallowed by the
     * command's own fallback, so it cannot distinguish "never reached" from
     * "reached and recovered".
     */
    let wroteReport = false;
    let openedBrowser = false;

    await runReportCommand(["--input", "-"], {
      ensureUnambiguousCompanion: async () => true,
      readInput: async () => JSON.stringify({ version: REPORT_DOCUMENT_VERSION }),
      writeTemporaryReport: async () => {
        wroteReport = true;
        return "/tmp/mate-report/report.html";
      },
      openReportInBrowser: async () => {
        openedBrowser = true;
      },
    });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("title"));
    expect(wroteReport).toBe(false);
    expect(openedBrowser).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  test("rejects days and structured input mode conflicts", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await runReportCommand(["--days", "7", "--input", "-"], {
      ensureUnambiguousCompanion: async () => true,
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cannot be combined"));
    errorSpy.mockRestore();
  });

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

  test("uses bounded savings entries for report summary totals", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const resolveFrameworkContext = () => ({
      configStore: {
        load: async () => ({ capabilities: [{ name: "tokensave" }, { name: "rtk" }] }),
      },
      workingRepoStore: {
        load: async () => ({ repos: [{ id: "test", path: "/tmp/test-work" }] }),
      },
      companionPath: COMPANION_PATH,
    });
    const spawn = (command: string) => {
      if (command === "tokensave") {
        return {
          stdout: JSON.stringify([
            { day: 1787443200, saved_tokens: 100, calls: 1, usd: 1 },
            { day: 1787529600, saved_tokens: 200, calls: 2, usd: 2 },
          ]),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      }
      if (command === "rtk") {
        return {
          stdout: JSON.stringify({
            summary: { total_saved: 90000, total_commands: 90 },
            daily: [{ date: "2026-08-24", saved_tokens: 300, commands: 3 }],
          }),
          status: 0,
          error: null,
        } as ReturnType<typeof spawnSync>;
      }
      return {
        stdout: JSON.stringify({
          daily: [
            {
              modelBreakdowns: [
                {
                  modelName: "claude-sonnet-5",
                  cost: 1,
                  inputTokens: 100,
                  outputTokens: 50,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                },
              ],
            },
          ],
        }),
        status: 0,
        error: null,
      } as ReturnType<typeof spawnSync>;
    };

    await runReportCommand(["--days", "7", "--json"], {
      ensureUnambiguousCompanion: async () => true,
      resolveFrameworkContext,
      spawn,
      now: () => REPORT_NOW,
    });

    const document = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(document.summary).toEqual([
      { label: "Total spending", value: "$1.00" },
      { label: "Total savings", value: "$4.00" },
      { label: "Net spend", value: "$-3.00" },
    ]);
    expect(
      document.sections.find((section: { id: string }) => section.id === "savings").rows,
    ).toEqual([
      ["tokensave", "400", "4", "$4.00", "100/call"],
      ["rtk", "300", "3", "N/A", "100/call"],
    ]);
    logSpy.mockRestore();
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
            repos: [{ id: "test", path: "/tmp/test-work" }],
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

  describe("inside a Studio session", () => {
    const run = async (publish: () => Promise<{ id: string; url?: string } | null>) => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      let written = 0;
      let opened = 0;
      await runReportCommand(["--input", "r.json"], {
        ensureUnambiguousCompanion: async () => true,
        readInput: async () => structuredDocument,
        publishReportToStudio: publish,
        writeTemporaryReport: async () => {
          written += 1;
          return "/tmp/mate-report/report.html";
        },
        openReportInBrowser: async () => {
          opened += 1;
        },
      });
      const out = { logs: logSpy.mock.calls.map(String), warns: warnSpy.mock.calls.map(String) };
      logSpy.mockRestore();
      warnSpy.mockRestore();
      return { ...out, written, opened };
    };

    test("prints the public URL Studio supplied and skips the temp file and browser", async () => {
      const result = await run(async () => ({
        id: "abc",
        url: "https://studio.acme.test/studio/reports/abc",
      }));
      expect(result.logs).toEqual([
        "Report hosted in Studio: https://studio.acme.test/studio/reports/abc",
      ]);
      expect([result.written, result.opened]).toEqual([0, 0]);
    });

    test("points to Studio Reports with the id when no public origin exists", async () => {
      const result = await run(async () => ({ id: "abc" }));
      expect(result.logs).toEqual(["Report hosted in Studio: open Studio → Reports (report abc)"]);
      expect(result.logs.join()).not.toContain("/tmp/");
      expect(result.logs.join()).not.toContain("127.0.0.1");
    });

    test("falls back to the temp file and browser with a warning when Studio refuses", async () => {
      const result = await run(async () => {
        throw new Error("Studio refused the report (HTTP 401)");
      });
      expect(result.warns.join()).toContain("Studio refused the report (HTTP 401)");
      expect([result.written, result.opened]).toEqual([1, 1]);
      expect(result.logs.join()).toContain("Report opened from");
    });

    test("falls back when Studio is unreachable", async () => {
      const result = await run(async () => {
        throw new Error("Studio did not answer in time");
      });
      expect(result.warns.join()).toContain("did not answer");
      expect([result.written, result.opened]).toEqual([1, 1]);
    });

    test("outside Studio (no hosting) uses the temp file and browser", async () => {
      const result = await run(async () => null);
      expect([result.written, result.opened]).toEqual([1, 1]);
    });

    test("--json never publishes", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      await runReportCommand(["--input", "r.json", "--json"], {
        ensureUnambiguousCompanion: async () => true,
        readInput: async () => structuredDocument,
        publishReportToStudio: async () => {
          throw new Error("JSON mode must not publish");
        },
      });
      expect(() => JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toThrow();
      logSpy.mockRestore();
    });
  });
});
