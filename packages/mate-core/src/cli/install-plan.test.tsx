/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";

import type { InstallPlan, InstallPlanItem, InstallRequirementResult } from "../lib/install";
import { InstallExecutionView, renderInstallExecution } from "./install-plan";

function item(overrides: Partial<InstallPlanItem>): InstallPlanItem {
  return {
    id: "test:tool",
    label: "Test tool",
    group: "core",
    source: "test",
    command: "install test-tool",
    satisfied: true,
    detect: () => true,
    install: async () => {},
    ...overrides,
  };
}

function plan(requirements: InstallPlanItem[]): InstallPlan {
  return {
    context: { kind: "core", config: {} as never, fingerprint: "context" },
    fingerprint: "requirements",
    requirements,
    deferred: [],
  };
}

/** Renders into a fake 80-column stream and returns every frame Ink wrote, ANSI stripped. */
function captureView(target: InstallPlan) {
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    frames: [] as string[],
    write(chunk: string) {
      stdout.frames.push(Bun.stripANSI(chunk));
      return true;
    },
  });
  const done = new Promise<{ ok: boolean; results: InstallRequirementResult[] }>((resolve) => {
    const app = render(
      <InstallExecutionView
        plan={target}
        onDone={(execution) => {
          app.unmount();
          resolve(execution);
        }}
      />,
      { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false },
    );
  });
  return { done, output: () => stdout.frames.join("") };
}

describe("renderInstallExecution", () => {
  test("renders execution and reports detected requirements as already installed", async () => {
    const execution = await renderInstallExecution(plan([item({})]));

    expect(execution).toEqual({
      ok: true,
      results: [{ id: "test:tool", status: "skipped", verified: true }],
    });
  });
});

describe("InstallExecutionView", () => {
  test("shows facts per row without boxes, bars or reassurance copy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const view = captureView(
      plan([
        item({ id: "a", label: "Present tool" }),
        item({
          id: "b",
          label: "Missing tool",
          satisfied: false,
          install: () => gate,
        }),
      ]),
    );

    await Bun.sleep(50);
    const running = view.output();
    expect(running).toContain("mate install · core");
    expect(running).toMatch(/✓ Present tool\s+present/);
    expect(running).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Missing tool\s+install test-tool/);
    expect(running).toContain("1 / 2");

    release();
    await view.done;
    const output = view.output();
    expect(output).toMatch(/✓ Missing tool\s+installed/);
    expect(output).not.toMatch(/[╭╮╰╯│─█░]/);
    expect(output).not.toMatch(/Working|Preparing|Finalizing/);
  });

  test("a failed row shows only the first error line", async () => {
    const view = captureView(
      plan([
        item({
          satisfied: false,
          install: async () => {
            throw new Error("exit 1: acme not found\nstack line");
          },
        }),
      ]),
    );

    const execution = await view.done;
    expect(execution.ok).toBe(false);
    const output = view.output();
    expect(output).toMatch(/✗ Test tool\s+failed\s+exit 1: acme not found/);
    expect(output).not.toContain("stack line");
  });
});
