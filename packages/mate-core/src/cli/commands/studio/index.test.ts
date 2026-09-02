import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runStudioCommand, type StudioCommandDeps } from "./index";
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
});
