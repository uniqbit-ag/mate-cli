import { afterEach, describe, expect, mock, test } from "bun:test";

import { createVscodeMock } from "./test-support/vscode-mock";

afterEach(() => {
  mock.restore();
});

function serviceReturning(changeRoot: string) {
  return {
    getChangeRoot: async () => changeRoot,
  };
}

describe("openOpenSpecChange", () => {
  test("opens the change's proposal.md when it exists", async () => {
    const { module, calls } = createVscodeMock();
    mock.module("vscode", () => module);
    const { openOpenSpecChange } = await import("./openspec-actions");

    await openOpenSpecChange(serviceReturning("/companions/a/openspec/changes/add-foo") as never, {
      name: "add-foo",
      companionPath: "/companions/a",
    });

    expect(calls.showTextDocument).toHaveLength(1);
    expect(calls.executeCommand).toEqual([]);
  });

  test("falls back to revealing the change folder when the proposal cannot be opened", async () => {
    const { module, calls, openTextDocumentBehavior } = createVscodeMock();
    openTextDocumentBehavior.fn = () => Promise.reject(new Error("no such file"));
    mock.module("vscode", () => module);
    const { openOpenSpecChange } = await import("./openspec-actions");

    await openOpenSpecChange(serviceReturning("/companions/a/openspec/changes/add-foo") as never, {
      name: "add-foo",
      companionPath: "/companions/a",
    });

    expect(calls.showTextDocument).toEqual([]);
    expect(calls.executeCommand[0]?.[0]).toBe("revealFileInOS");
  });

  test("shows an error and never opens anything when the change root cannot be resolved", async () => {
    const { module, calls } = createVscodeMock();
    mock.module("vscode", () => module);
    const { openOpenSpecChange } = await import("./openspec-actions");
    const service = { getChangeRoot: async () => Promise.reject(new Error("unknown change")) };

    await openOpenSpecChange(service as never, { name: "add-foo", companionPath: "/companions/a" });

    expect(calls.showErrorMessage).toHaveLength(1);
    expect(calls.showTextDocument).toEqual([]);
    expect(calls.executeCommand).toEqual([]);
  });
});

describe("registerOpenSpecCommands", () => {
  test("registers the open-change command and delegates to openOpenSpecChange", async () => {
    const { module, calls, registeredCommands } = createVscodeMock();
    mock.module("vscode", () => module);
    const { registerOpenSpecCommands } = await import("./openspec-actions");
    const { OPEN_OPENSPEC_CHANGE_COMMAND } = await import("./openspec-tree-provider");
    const context = { subscriptions: [] as unknown[] };

    registerOpenSpecCommands(
      context as never,
      serviceReturning("/companions/a/openspec/changes/add-foo") as never,
    );
    await registeredCommands.get(OPEN_OPENSPEC_CHANGE_COMMAND)?.({
      name: "add-foo",
      companionPath: "/companions/a",
    });

    expect(calls.showTextDocument).toHaveLength(1);
  });

  test("ignores an invocation with no valid argument (e.g. from the Command Palette)", async () => {
    const { module, calls, registeredCommands } = createVscodeMock();
    mock.module("vscode", () => module);
    const { registerOpenSpecCommands } = await import("./openspec-actions");
    const { OPEN_OPENSPEC_CHANGE_COMMAND } = await import("./openspec-tree-provider");
    const context = { subscriptions: [] as unknown[] };

    registerOpenSpecCommands(context as never, serviceReturning("/x") as never);
    await registeredCommands.get(OPEN_OPENSPEC_CHANGE_COMMAND)?.(undefined);

    expect(calls.showTextDocument).toEqual([]);
    expect(calls.showErrorMessage).toEqual([]);
  });
});
