import { describe, expect, test } from "bun:test";

import { OpenSpecCliUnavailableError } from "./openspec-cli-client";
import { OpenSpecService } from "./openspec-service";

describe("OpenSpecService.listChanges", () => {
  test("parses a successful openspec list response", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => ({
        code: 0,
        stdout: JSON.stringify({
          changes: [{ name: "add-foo", completedTasks: 1, totalTasks: 4, status: "in-progress" }],
        }),
        stderr: "",
      }),
    });

    expect(await service.listChanges()).toEqual([
      { name: "add-foo", completedTasks: 1, totalTasks: 4, status: "in-progress" },
    ]);
  });

  test("throws with the CLI's stderr diagnostic on a non-zero exit", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => ({ code: 1, stdout: "", stderr: "openspec: no root found" }),
    });

    await expect(service.listChanges()).rejects.toThrow("openspec: no root found");
  });

  test("overrides the configured cwd with an explicit per-companion cwd", async () => {
    const calls: unknown[] = [];
    const service = new OpenSpecService({
      options: () => ({ cwd: "/default" }),
      runOpenSpecCli: async (args, options) => {
        calls.push(options);
        return { code: 0, stdout: JSON.stringify({ changes: [] }), stderr: "" };
      },
    });

    await service.listChanges("/companions/a");

    expect(calls).toEqual([{ cwd: "/companions/a" }]);
  });
});

describe("OpenSpecService.getChangeRoot", () => {
  test("extracts changeRoot from a successful openspec status response", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => ({
        code: 0,
        stdout: JSON.stringify({ changeRoot: "/companions/a/openspec/changes/add-foo" }),
        stderr: "",
      }),
    });

    expect(await service.getChangeRoot("add-foo", "/companions/a")).toBe(
      "/companions/a/openspec/changes/add-foo",
    );
  });

  test("passes the change name and cwd through to the CLI invocation", async () => {
    const calls: Array<{ args: string[]; options: unknown }> = [];
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async (args, options) => {
        calls.push({ args, options });
        return { code: 0, stdout: JSON.stringify({ changeRoot: "/x" }), stderr: "" };
      },
    });

    await service.getChangeRoot("add-foo", "/companions/a");

    expect(calls).toEqual([
      { args: ["status", "--change", "add-foo", "--json"], options: { cwd: "/companions/a" } },
    ]);
  });

  test("throws with the CLI's stderr diagnostic on a non-zero exit", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => ({ code: 1, stdout: "", stderr: "openspec: unknown change" }),
    });

    await expect(service.getChangeRoot("add-foo")).rejects.toThrow("openspec: unknown change");
  });
});

describe("OpenSpecService.isOpenSpecAvailable", () => {
  test("returns false when the CLI cannot be spawned", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => {
        throw new OpenSpecCliUnavailableError("not found");
      },
    });

    expect(await service.isOpenSpecAvailable()).toBe(false);
  });

  test("returns true when openspec --version succeeds", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => ({ code: 0, stdout: "1.8.0", stderr: "" }),
    });

    expect(await service.isOpenSpecAvailable()).toBe(true);
  });

  test("re-throws an unrelated error rather than reporting openspec as merely unavailable", async () => {
    const service = new OpenSpecService({
      options: () => ({}),
      runOpenSpecCli: async () => {
        throw new Error("unexpected");
      },
    });

    await expect(service.isOpenSpecAvailable()).rejects.toThrow("unexpected");
  });
});
