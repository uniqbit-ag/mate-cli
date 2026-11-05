/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { ReactElement } from "react";

import { emitWarning, releaseTerminal } from "../live-progress";
import {
  createStartupProgress,
  type StartupProgressAppProps,
  type StartupProgressController,
  type StartupProgressDeps,
} from "./startup-progress";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

const live: StartupProgressController[] = [];
afterEach(() => {
  while (live.length) live.pop()?.stop();
});

/** Every controller is stopped after its test so the live-progress hook never leaks. */
function track(controller: StartupProgressController): StartupProgressController {
  live.push(controller);
  return controller;
}

function fakeStdout(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns: 80,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, output: () => chunks.join("") };
}

function fakeRender() {
  const renders: StartupProgressAppProps[] = [];
  let unmounted = false;
  let mounts = 0;

  const instance = {
    rerender(element: ReactElement) {
      renders.push(element.props as StartupProgressAppProps);
    },
    unmount() {
      unmounted = true;
    },
  };

  const render: NonNullable<StartupProgressDeps["render"]> = ((element: ReactElement) => {
    mounts += 1;
    unmounted = false;
    renders.push(element.props as StartupProgressAppProps);
    return instance;
  }) as unknown as NonNullable<StartupProgressDeps["render"]>;

  const stdout = fakeStdout(true);
  return {
    deps: { render, stdout: stdout.stream, interactive: true } satisfies StartupProgressDeps,
    output: stdout.output,
    renders,
    mounts: () => mounts,
    isUnmounted: () => unmounted,
  };
}

describe("createStartupProgress", () => {
  test("start appends a running step", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("sync", "Syncing mate");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "sync", label: "Syncing mate", status: "running" },
    ]);
  });

  test("succeed marks the matching step done without touching others", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("sync", "Syncing mate");
    progress.start("graphify", "Indexing graphify");
    progress.succeed("sync");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "sync", label: "Syncing mate", status: "done" },
      { id: "graphify", label: "Indexing graphify", status: "running" },
    ]);
  });

  test("reuses an existing step id instead of rendering duplicates", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("graphify", "Indexing graphify");
    progress.succeed("graphify");
    progress.start("graphify", "Indexing graphify again");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "graphify", label: "Indexing graphify again", status: "running" },
    ]);
  });

  test("fail marks the matching step as error", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("tokensave", "Indexing tokensave");
    progress.fail("tokensave");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "tokensave", label: "Indexing tokensave", status: "error" },
    ]);
  });

  test("failCurrent marks whichever step is running as errored", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("sync", "Syncing mate");
    progress.succeed("sync");
    progress.start("graphify", "Indexing graphify");
    progress.failCurrent();

    expect(renders.at(-1)?.steps).toEqual([
      { id: "sync", label: "Syncing mate", status: "done" },
      { id: "graphify", label: "Indexing graphify", status: "error" },
    ]);
  });

  test("failCurrent is a no-op when no step is running", () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("sync", "Syncing mate");
    progress.succeed("sync");
    const beforeCount = renders.length;
    progress.failCurrent();

    expect(renders.length).toBe(beforeCount);
  });

  test("stop unmounts and suppresses further rerenders", () => {
    const { deps, renders, isUnmounted } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("sync", "Syncing mate");
    progress.stop();
    expect(isUnmounted()).toBe(true);

    const countAfterStop = renders.length;
    progress.succeed("sync");
    expect(renders.length).toBe(countAfterStop);
  });

  test("renders finished steps as a log and only the running step with a spinner", () => {
    let element!: ReactElement;
    const render = ((next: ReactElement) => {
      element = next;
      return {
        rerender: (rerendered: ReactElement) => {
          element = rerendered;
        },
        unmount: () => {},
      };
    }) as unknown as NonNullable<StartupProgressDeps["render"]>;
    const progress = track(createStartupProgress("Starting claude", { render, interactive: true }));

    progress.start("sync", "Syncing mate");
    progress.succeed("sync");
    progress.start("graphify", "Indexing graphify");
    progress.fail("graphify");
    progress.start("tokensave", "Indexing tokensave");

    const rows = renderToString(element, { columns: 80 })
      .split("\n")
      .filter((row) => row.trim() !== "");
    expect(rows[0]).toBe("mate · Starting claude");
    expect(rows[1]).toMatch(/✓ Syncing mate$/);
    expect(rows[2]).toMatch(/✗ Indexing graphify failed$/);
    expect(rows[3]).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Indexing tokensave$/);
    expect(rows.filter((row) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row))).toHaveLength(1);
  });

  test("step finishes done when fn resolves and returns its value", async () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Setting up companion", deps));

    const value = await progress.step("apply", "Applying capabilities", async () => 42);

    expect(value).toBe(42);
    expect(renders.at(-1)?.log.map(({ kind, label }) => [kind, label])).toEqual([
      ["done", "Applying capabilities"],
    ]);
  });

  test("step finishes error and rethrows when fn throws", async () => {
    const { deps, renders } = fakeRender();
    const progress = track(createStartupProgress("Setting up companion", deps));

    await expect(
      progress.step("apply", "Applying capabilities", () => {
        throw new Error("acme broke");
      }),
    ).rejects.toThrow("acme broke");
    expect(renders.at(-1)?.log.map(({ kind }) => kind)).toEqual(["error"]);
  });

  test("routes emitWarning into the log while live and back to stderr after stop", () => {
    const { deps, renders } = fakeRender();
    const progress = createStartupProgress("Setting up companion", deps);

    progress.start("apply", "Applying capabilities");
    emitWarning("acme capability disabled: missing tool");
    expect(renders.at(-1)?.log).toEqual([
      { key: "warning:0", kind: "warning", label: "acme capability disabled: missing tool" },
    ]);
    expect(renders.at(-1)?.steps.at(-1)?.status).toBe("running");

    progress.stop();
    const original = process.stderr.write;
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof original;
    try {
      emitWarning("after stop");
    } finally {
      process.stderr.write = original;
    }
    expect(written).toEqual(["after stop\n"]);
  });

  test("handOver prints a start line, unmounts, and writes the result line directly", () => {
    const { deps, renders, isUnmounted, output } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.handOver("sync", "Syncing mate");
    expect(renders.at(-1)?.log.map(({ kind, label }) => [kind, label])).toEqual([
      ["handover", "Syncing mate"],
    ]);
    expect(renders.at(-1)?.steps).toEqual([]);
    expect(isUnmounted()).toBe(true);

    progress.succeed("sync");
    expect(output()).toMatch(/✓ Syncing mate\n$/);
    expect(output()).not.toMatch(SPINNER);
  });

  test("a live step after a hand-over remounts without repeating the header", () => {
    const { deps, renders, mounts, output } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.start("check", "Checking registry");
    progress.succeed("check");
    progress.handOver("upgrade", "Upgrading to 2.0.0");
    progress.succeed("upgrade");
    progress.start("finish", "Finishing");

    expect(mounts()).toBe(2);
    expect(renders.at(-1)).toMatchObject({
      showHeader: false,
      log: [],
      steps: [
        { id: "check", status: "done" },
        { id: "finish", status: "running" },
      ],
    });
    expect(output()).toMatch(/✓ Upgrading to 2\.0\.0\n$/);
  });

  test("releaseTerminal turns the running live step into a handed-over step", () => {
    const { deps, renders, isUnmounted, output } = fakeRender();
    const progress = track(createStartupProgress("Setting up companion", deps));

    progress.start("apply", "Applying capabilities");
    releaseTerminal();

    expect(renders.at(-1)?.steps).toEqual([]);
    expect(renders.at(-1)?.log.map(({ kind, label }) => [kind, label])).toEqual([
      ["handover", "Applying capabilities"],
    ]);
    expect(isUnmounted()).toBe(true);

    progress.fail("apply");
    expect(output()).toMatch(/✗ Applying capabilities failed\n$/);
  });

  test("failCurrent fails a handed-over step when no live step runs", () => {
    const { deps, output } = fakeRender();
    const progress = track(createStartupProgress("Starting claude", deps));

    progress.handOver("sync", "Syncing mate");
    progress.failCurrent();

    expect(output()).toMatch(/✗ Syncing mate failed\n$/);
  });

  test("renders warning and hand-over rows", () => {
    let element!: ReactElement;
    const render = ((next: ReactElement) => {
      element = next;
      return {
        rerender: (rerendered: ReactElement) => {
          element = rerendered;
        },
        unmount: () => {},
      };
    }) as unknown as NonNullable<StartupProgressDeps["render"]>;
    const progress = track(
      createStartupProgress("Setting up companion", { render, interactive: true }),
    );

    progress.warn("acme capability disabled: missing tool");
    progress.handOver("acme", "Cloning companion");

    const rows = renderToString(element, { columns: 80 })
      .split("\n")
      .filter((row) => row.trim() !== "");
    expect(rows[1]).toBe("  warning acme capability disabled: missing tool");
    expect(rows[2]).toBe("  Cloning companion");
    expect(rows.some((row) => SPINNER.test(row))).toBe(false);
  });
});

describe("createStartupProgress outside a TTY", () => {
  test("prints the header and one plain line per finished entry", async () => {
    const stdout = fakeStdout(false);
    const progress = createStartupProgress("Setting up companion", { stdout: stdout.stream });

    await progress.step("plugins", "Installing plugins", () => {});
    progress.start("apply", "Applying capabilities");
    progress.fail("apply");
    progress.handOver("clone", "Cloning companion");
    progress.succeed("clone");
    progress.stop();

    expect(stdout.output()).toBe(
      [
        "mate · Setting up companion",
        "  ✓ Installing plugins",
        "  ✗ Applying capabilities failed",
        "  Cloning companion",
        "  ✓ Cloning companion",
        "",
      ].join("\n"),
    );
    expect(stdout.output()).not.toMatch(SPINNER);
    expect(stdout.output()).not.toContain("\u001b");
  });

  test("leaves warnings on stderr", () => {
    const stdout = fakeStdout(false);
    const stderr = fakeStdout(false);
    const progress = createStartupProgress("Setting up companion", {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    progress.warn("acme warning");
    progress.stop();

    expect(stdout.output()).toBe("mate · Setting up companion\n");
    expect(stderr.output()).toBe("acme warning\n");
  });
});
