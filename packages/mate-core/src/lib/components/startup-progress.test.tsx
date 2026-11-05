/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import type { ReactElement } from "react";

import {
  createStartupProgress,
  type StartupProgressAppProps,
  type StartupProgressDeps,
} from "./startup-progress";

function fakeRender() {
  const renders: StartupProgressAppProps[] = [];
  let unmounted = false;

  const instance = {
    rerender(element: ReactElement) {
      renders.push(element.props as StartupProgressAppProps);
    },
    unmount() {
      unmounted = true;
    },
  };

  const render: NonNullable<StartupProgressDeps["render"]> = ((element: ReactElement) => {
    renders.push(element.props as StartupProgressAppProps);
    return instance;
  }) as unknown as NonNullable<StartupProgressDeps["render"]>;

  return {
    render,
    renders,
    isUnmounted: () => unmounted,
  };
}

describe("createStartupProgress", () => {
  test("start appends a running step", () => {
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

    progress.start("sync", "Syncing mate");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "sync", label: "Syncing mate", status: "running" },
    ]);
  });

  test("succeed marks the matching step done without touching others", () => {
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

    progress.start("sync", "Syncing mate");
    progress.start("graphify", "Indexing graphify");
    progress.succeed("sync");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "sync", label: "Syncing mate", status: "done" },
      { id: "graphify", label: "Indexing graphify", status: "running" },
    ]);
  });

  test("reuses an existing step id instead of rendering duplicates", () => {
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

    progress.start("graphify", "Indexing graphify");
    progress.succeed("graphify");
    progress.start("graphify", "Indexing graphify again");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "graphify", label: "Indexing graphify again", status: "running" },
    ]);
  });

  test("fail marks the matching step as error", () => {
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

    progress.start("tokensave", "Indexing tokensave");
    progress.fail("tokensave");

    expect(renders.at(-1)?.steps).toEqual([
      { id: "tokensave", label: "Indexing tokensave", status: "error" },
    ]);
  });

  test("failCurrent marks whichever step is running as errored", () => {
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

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
    const { render, renders } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

    progress.start("sync", "Syncing mate");
    progress.succeed("sync");
    const beforeCount = renders.length;
    progress.failCurrent();

    expect(renders.length).toBe(beforeCount);
  });

  test("stop unmounts and suppresses further rerenders", () => {
    const { render, renders, isUnmounted } = fakeRender();
    const progress = createStartupProgress("Starting claude", { render });

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
    const progress = createStartupProgress("Starting claude", { render });

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
});
