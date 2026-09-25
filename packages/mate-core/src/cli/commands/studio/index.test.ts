import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { parseStudioServeArgs, runStudioCommand, type StudioCommandDeps } from "./index";
import type { StudioServerHandle } from "./server";

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

function handle(stopped: { value: boolean } = { value: false }): StudioServerHandle {
  return {
    url: "http://localhost:54321",
    address: "http://localhost:54321",
    port: 54321,
    hostname: "127.0.0.1",
    stop: () => {
      stopped.value = true;
    },
  };
}

interface Recorded {
  out: string[];
  err: string[];
  opened: string[];
  served: StudioServerHandle[];
  deps: StudioCommandDeps;
}

function recording(overrides: Partial<StudioCommandDeps> = {}): Recorded {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const served: StudioServerHandle[] = [];
  return {
    out,
    err,
    opened,
    served,
    deps: {
      startStudioServer: () => handle(),
      serveUntilInterrupted: async (server) => {
        served.push(server);
      },
      openInBrowser: async (url) => {
        opened.push(url);
      },
      log: (message) => out.push(message),
      warn: (message) => err.push(message),
      ...overrides,
    },
  };
}

describe("runStudioCommand", () => {
  test("reports the resolved URL and serves until interrupted", async () => {
    const recorded = recording();

    await runStudioCommand([], recorded.deps);

    expect(recorded.out).toContain("http://localhost:54321");
    expect(recorded.served).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  test("opens the platform browser at the served URL once bound", async () => {
    const order: string[] = [];
    const recorded = recording({
      startStudioServer: () => {
        order.push("bind");
        return handle();
      },
      openInBrowser: async (url) => {
        order.push(`open:${url}`);
      },
    });

    await runStudioCommand([], recorded.deps);

    expect(order).toEqual(["bind", "open:http://localhost:54321"]);
  });

  test("rejects an unrecognized argument before starting a server", async () => {
    let started = false;
    const recorded = recording({
      startStudioServer: () => {
        started = true;
        return handle();
      },
    });

    await runStudioCommand(["--port", "8080"], recorded.deps);

    expect(started).toBe(false);
    expect(recorded.err.join("\n")).toContain("--port");
    expect(process.exitCode).toBe(1);
  });

  test("keeps serving and keeps reporting the URL when the browser cannot be opened", async () => {
    const recorded = recording({
      openInBrowser: async () => {
        throw new Error("xdg-open missing");
      },
    });

    await runStudioCommand([], recorded.deps);

    expect(recorded.err.join("\n")).toContain("xdg-open missing");
    expect(recorded.out.join("\n")).toContain("http://localhost:54321");
    expect(recorded.served).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  test("reports a bind failure on stderr and exits non-zero without opening a browser", async () => {
    const recorded = recording({
      startStudioServer: () => {
        throw new Error("EADDRINUSE");
      },
    });

    await runStudioCommand([], recorded.deps);

    expect(recorded.err.join("\n")).toContain("EADDRINUSE");
    expect(recorded.opened).toEqual([]);
    expect(recorded.served).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("resolves its content without a Repository Link", async () => {
    const recorded = recording();

    await runStudioCommand([], recorded.deps);

    expect(recorded.err).toEqual([]);
    expect(recorded.served).toHaveLength(1);
  });

  test("accepts writable on the interactive invocation", async () => {
    let options: unknown;
    const recorded = recording({
      startStudioServer: (_deps, next) => {
        options = next;
        return handle();
      },
    });
    await runStudioCommand(["--writable"], recorded.deps);
    expect(options).toEqual({ writable: true });
    expect(recorded.err).toEqual([]);
  });

  test("parses and dispatches the headless serve path without opening a browser", async () => {
    const recorded = recording({
      startStudioServer: (_deps, options) => {
        expect(options).toEqual({
          port: 4180,
          hostname: "0.0.0.0",
          writable: false,
          invocation: "serve",
        });
        return {
          ...handle(),
          url: "http://0.0.0.0:4180",
          address: "http://localhost:4180/?token=t",
          hostname: "0.0.0.0",
          port: 4180,
        };
      },
      openInBrowser: async () => {
        throw new Error("browser must not open");
      },
    });

    await runStudioCommand(["serve", "--port", "4180", "--host", "0.0.0.0"], recorded.deps);

    expect(recorded.out).toEqual(["http://localhost:4180/?token=t"]);
    expect(recorded.out.join("\n")).not.toContain("Press Ctrl+C to stop.");
    expect(recorded.opened).toEqual([]);
    expect(recorded.served).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  test("accepts writable on the headless invocation", async () => {
    let options: unknown;
    const recorded = recording({
      startStudioServer: (_deps, next) => {
        options = next;
        return handle();
      },
    });
    await runStudioCommand(["serve", "--port", "4180", "--writable"], recorded.deps);
    expect(options).toEqual({
      port: 4180,
      hostname: "127.0.0.1",
      writable: true,
      invocation: "serve",
    });
    expect(recorded.err).toEqual([]);
  });

  test.each([
    { argv: ["--host", "0.0.0.0"], text: "port" },
    { argv: ["--bogus", "x"], text: "--bogus" },
    { argv: ["--port"], text: "--port" },
    { argv: ["--port", "nope"], text: "nope" },
    { argv: ["--port", "65536"], text: "65536" },
  ])("rejects invalid serve arguments before binding: $argv", async ({ argv, text }) => {
    let started = false;
    const recorded = recording({
      startStudioServer: () => {
        started = true;
        return handle();
      },
    });

    await runStudioCommand(["serve", ...argv], recorded.deps);

    expect(started).toBe(false);
    expect(recorded.err.join("\n")).toContain(text);
    expect(process.exitCode).toBe(1);
  });

  test("reports a serve bind failure without retrying another port", async () => {
    let starts = 0;
    const recorded = recording({
      startStudioServer: () => {
        starts += 1;
        throw new Error("EADDRINUSE");
      },
    });

    await runStudioCommand(["serve", "--port", "4180"], recorded.deps);

    expect(starts).toBe(1);
    expect(recorded.err.join("\n")).toContain("EADDRINUSE");
    expect(recorded.served).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe("parseStudioServeArgs", () => {
  test("parses a port and optional host", () => {
    expect(parseStudioServeArgs(["--port", "4180", "--host", "0.0.0.0"])).toEqual({
      port: 4180,
      hostname: "0.0.0.0",
      writable: false,
      invocation: "serve",
    });
  });

  test("defaults a host-only bind to loopback when a port is supplied", () => {
    expect(parseStudioServeArgs(["--port", "4180"])).toEqual({
      port: 4180,
      hostname: "127.0.0.1",
      writable: false,
      invocation: "serve",
    });
  });
});

describe("guarded invocations", () => {
  const TOKEN = "p".repeat(40);

  test("opens the tokened address on the interactive terminal invocation", async () => {
    let options: unknown;
    const recorded = recording({
      terminalUnsupportedReason: () => null,
      startStudioServer: (_deps, next) => {
        options = next;
        return { ...handle(), address: "http://localhost:54321/?token=abc" };
      },
    });
    await runStudioCommand(["--writable", "--terminal", "--detach-timeout", "10"], recorded.deps);
    expect(options).toEqual({ writable: true, terminal: true, detachMinutes: 10 });
    expect(recorded.out).toContain("http://localhost:54321/?token=abc");
    expect(recorded.opened).toEqual(["http://localhost:54321/?token=abc"]);
  });

  test("uses a pinned token without printing it", async () => {
    let options: { token?: string } | undefined;
    const recorded = recording({
      env: { MATE_STUDIO_TOKEN: TOKEN },
      startStudioServer: (_deps, next) => {
        options = next as typeof options;
        return handle();
      },
    });
    await runStudioCommand(["serve", "--port", "4180"], recorded.deps);
    expect(options?.token).toBe(TOKEN);
    expect([...recorded.out, ...recorded.err].join("\n")).not.toContain(TOKEN);
    expect(process.exitCode).toBe(0);
  });

  test.each([
    { argv: ["--token", "short"], text: "--token" },
    { argv: ["--token", "   "], text: "--token" },
  ])("refuses a weak pinned token: $argv", async ({ argv, text }) => {
    let started = false;
    const recorded = recording({
      startStudioServer: () => {
        started = true;
        return handle();
      },
    });
    await runStudioCommand(["serve", "--port", "4180", ...argv], recorded.deps);
    expect(started).toBe(false);
    expect(recorded.err.join("\n")).toContain(text);
    expect(recorded.err.join("\n")).not.toContain("short");
    expect(process.exitCode).toBe(1);
  });

  test("the unguarded interactive command passes no token setting", async () => {
    let options: unknown;
    const recorded = recording({
      env: { MATE_STUDIO_TOKEN: TOKEN },
      startStudioServer: (_deps, next) => {
        options = next;
        return handle();
      },
    });
    await runStudioCommand([], recorded.deps);
    expect(options).toEqual({ writable: false });
  });
});

describe("terminal flags", () => {
  test("refuses --terminal without --writable, naming it", async () => {
    let started = false;
    const recorded = recording({
      terminalUnsupportedReason: () => null,
      startStudioServer: () => {
        started = true;
        return handle();
      },
    });
    await runStudioCommand(["--terminal"], recorded.deps);
    expect(started).toBe(false);
    expect(recorded.err.join("\n")).toContain("--writable");
    expect(process.exitCode).toBe(1);
  });

  test("refuses --terminal where no native pseudo-terminal exists; the same call without it starts", async () => {
    let starts = 0;
    const recorded = recording({
      terminalUnsupportedReason: () => "requires Bun 1.3.5 or later",
      startStudioServer: () => {
        starts += 1;
        return handle();
      },
    });
    await runStudioCommand(["serve", "--port", "4180", "--writable", "--terminal"], recorded.deps);
    expect(starts).toBe(0);
    expect(recorded.err.join("\n")).toContain("Bun 1.3.5");
    expect(process.exitCode).toBe(1);

    process.exitCode = 0;
    await runStudioCommand(["serve", "--port", "4180", "--writable"], recorded.deps);
    expect(starts).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  test.each([
    ["--detach-timeout"],
    ["--detach-timeout", "0"],
    ["--detach-timeout", "1.5"],
    ["--detach-timeout", "-3"],
  ])("rejects an invalid detach window: %p", async (...argv) => {
    const recorded = recording({ terminalUnsupportedReason: () => null });
    await runStudioCommand(["--writable", "--terminal", ...argv], recorded.deps);
    expect(recorded.served).toEqual([]);
    expect(recorded.err.join("\n")).toContain("--detach-timeout");
    expect(process.exitCode).toBe(1);
  });

  test("accepts the appliance settings and pins a registered launch companion", async () => {
    let options: unknown;
    const recorded = recording({
      terminalUnsupportedReason: () => null,
      collectStudioInventory: async () => ({
        companions: [{ path: "/companions/acme", health: "ready", pairings: [] }],
      }),
      startStudioServer: (_deps, next) => {
        options = next;
        return handle();
      },
    });
    await runStudioCommand(
      [
        "serve",
        "--port",
        "4180",
        "--writable",
        "--terminal",
        "--companion",
        "/companions/acme",
        "--allowed-host",
        "studio.acme.test",
        "--public-origin",
        "https://studio.acme.test",
        "--no-git",
      ],
      recorded.deps,
    );
    expect(options).toEqual({
      port: 4180,
      hostname: "127.0.0.1",
      writable: true,
      invocation: "serve",
      terminal: true,
      allowedHosts: ["studio.acme.test"],
      publicOrigin: "https://studio.acme.test",
      launchCompanion: "/companions/acme",
      noGit: true,
    });
    expect(process.exitCode).toBe(0);
  });

  test("refuses an unregistered launch companion without binding", async () => {
    let started = false;
    const recorded = recording({
      terminalUnsupportedReason: () => null,
      collectStudioInventory: async () => ({ companions: [] }),
      startStudioServer: () => {
        started = true;
        return handle();
      },
    });
    await runStudioCommand(
      ["serve", "--port", "4180", "--writable", "--terminal", "--companion", "/companions/acme"],
      recorded.deps,
    );
    expect(started).toBe(false);
    expect(recorded.err.join("\n")).toContain("/companions/acme");
    expect(process.exitCode).toBe(1);
  });

  test.each([
    { argv: ["--public-origin", "https://studio.acme.test/app"], text: "--public-origin" },
    { argv: ["--allowed-host", "acme.test/x"], text: "--allowed-host" },
  ])("rejects an invalid proxy setting: $argv", async ({ argv, text }) => {
    const recorded = recording();
    await runStudioCommand(["serve", "--port", "4180", ...argv], recorded.deps);
    expect(recorded.served).toEqual([]);
    expect(recorded.err.join("\n")).toContain(text);
    expect(process.exitCode).toBe(1);
  });

  test("reads the proxy settings from the environment under serve", () => {
    expect(
      parseStudioServeArgs(["--port", "4180"], {
        MATE_STUDIO_ALLOWED_HOSTS: "studio.acme.test, admin.acme.test",
        MATE_STUDIO_PUBLIC_ORIGIN: "https://studio.acme.test",
      }),
    ).toEqual({
      port: 4180,
      hostname: "127.0.0.1",
      writable: false,
      invocation: "serve",
      allowedHosts: ["studio.acme.test", "admin.acme.test"],
      publicOrigin: "https://studio.acme.test",
    });
  });
});
