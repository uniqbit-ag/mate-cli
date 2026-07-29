import { describe, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { openReportInBrowser, writeTemporaryReport } from "./delivery";

describe("writeTemporaryReport", () => {
  test("writes report.html inside the injected temporary directory", async () => {
    let writtenPath = "";
    let writtenHTML = "";

    const reportPath = await writeTemporaryReport("<html></html>", {
      makeTempDir: async () => "/tmp/mate-report-unique",
      writeFile: async (filePath, content) => {
        writtenPath = filePath;
        writtenHTML = content;
      },
    });

    expect(reportPath).toBe("/tmp/mate-report-unique/report.html");
    expect(writtenPath).toBe(reportPath);
    expect(writtenHTML).toBe("<html></html>");
  });
});

describe("openReportInBrowser", () => {
  test.each([
    ["darwin", "open", ["/tmp/report.html"]],
    ["linux", "xdg-open", ["/tmp/report.html"]],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", "/tmp/report.html"]],
  ] as const)("uses the default launcher on %s", async (platform, command, expectedArgs) => {
    const calls: [string, string[]][] = [];
    const child = new EventEmitter() as unknown as ChildProcess;
    child.unref = () => child;
    const launch = ((actualCommand: string, args: string[]) => {
      calls.push([actualCommand, args]);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as typeof spawn;

    await openReportInBrowser("/tmp/report.html", {
      platform: () => platform,
      spawn: launch,
    });

    expect(calls).toEqual([[command, expectedArgs]]);
  });

  test("rejects when the launcher cannot start", async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    child.unref = () => child;
    const launch = (() => {
      queueMicrotask(() => child.emit("error", new Error("launcher missing")));
      return child;
    }) as typeof spawn;

    await expect(
      openReportInBrowser("/tmp/report.html", { platform: () => "linux", spawn: launch }),
    ).rejects.toThrow("launcher missing");
  });
});
