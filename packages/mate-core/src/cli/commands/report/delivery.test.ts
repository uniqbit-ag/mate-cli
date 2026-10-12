import { describe, expect, test } from "bun:test";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { openReportInBrowser, publishReportToStudio, writeTemporaryReport } from "./delivery";

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

describe("publishReportToStudio", () => {
  const env = {
    MATE_STUDIO_REPORT_URL: "http://127.0.0.1:4321",
    MATE_STUDIO_REPORT_TOKEN: "secret-token",
  };

  test("returns null outside a Studio session without calling out", async () => {
    const fetch = (async () => {
      throw new Error("must not call");
    }) as unknown as typeof globalThis.fetch;
    expect(await publishReportToStudio("T", "<p/>", { env: {}, fetch })).toBeNull();
    expect(
      await publishReportToStudio("T", "<p/>", {
        env: { MATE_STUDIO_REPORT_URL: "http://x" },
        fetch,
      }),
    ).toBeNull();
  });

  test("posts the title and html with the bearer credential", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetch = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(
        JSON.stringify({
          id: "abc",
          path: "/studio/reports/abc",
          url: "https://s.test/studio/reports/abc",
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const hosted = await publishReportToStudio("T", "<p/>", { env, fetch });
    expect(hosted).toEqual({ id: "abc", url: "https://s.test/studio/reports/abc" });
    expect(seen!.url).toBe("http://127.0.0.1:4321/api/reports");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-token",
    );
    expect(JSON.parse(String(seen!.init.body))).toEqual({ title: "T", html: "<p/>" });
  });

  test("omits url when Studio supplies none", async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({ id: "abc", path: "/studio/reports/abc" }),
      )) as unknown as typeof globalThis.fetch;
    expect(await publishReportToStudio("T", "x", { env, fetch })).toEqual({ id: "abc" });
  });

  test("failure messages never carry the credential or endpoint", async () => {
    const refused = (async () =>
      new Response("no", { status: 401 })) as unknown as typeof globalThis.fetch;
    const unreachable = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4321 secret-token");
    }) as unknown as typeof globalThis.fetch;
    for (const fetch of [refused, unreachable]) {
      const error = await publishReportToStudio("T", "x", { env, fetch }).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("secret-token");
      expect((error as Error).message).not.toContain("127.0.0.1");
    }
  });

  test("times out", async () => {
    const fetch = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;
    await expect(publishReportToStudio("T", "x", { env, fetch, timeoutMs: 20 })).rejects.toThrow(
      "did not answer",
    );
  });
});
