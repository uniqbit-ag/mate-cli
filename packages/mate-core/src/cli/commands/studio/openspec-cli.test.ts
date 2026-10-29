import { describe, expect, test } from "bun:test";

import type { OpenSpecRunOptions } from "../../../lib/openspec-cli";

import {
  listChanges,
  listSpecs,
  readAllChangeStatus,
  readOpenSpecJson,
  validateAll,
  type OpenSpecCliDeps,
} from "./openspec-cli";

interface Invocation {
  args: string[];
  options: OpenSpecRunOptions;
}

function recordingDeps(
  respond: (args: string[]) => { stdout: string; stderr?: string; code: number },
): { deps: OpenSpecCliDeps; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  return {
    invocations,
    deps: {
      run: async (args, options) => {
        invocations.push({ args, options });
        const result = respond(args);
        return { stdout: result.stdout, stderr: result.stderr ?? "", code: result.code };
      },
    },
  };
}

describe("readOpenSpecJson", () => {
  test("runs the bundled CLI in the companion, bounded by a timeout", async () => {
    const { deps, invocations } = recordingDeps(() => ({ stdout: "{}", code: 0 }));

    const result = await readOpenSpecJson("/companions/acme", ["list", "--json"], deps);

    expect(result).toEqual({ ok: true, value: {} });
    expect(invocations).toEqual([
      { args: ["list", "--json"], options: { cwd: "/companions/acme", timeout: 60_000 } },
    ]);
  });

  test("accepts a non-zero exit whose stdout is still valid JSON", async () => {
    const { deps } = recordingDeps(() => ({ stdout: '{"items":[]}', code: 1 }));

    const result = await readOpenSpecJson(
      "/companions/acme",
      ["validate", "--all", "--json"],
      deps,
    );

    expect(result).toEqual({ ok: true, value: { items: [] } });
  });

  test("returns a typed failure when the command fails without JSON", async () => {
    const { deps } = recordingDeps(() => ({ stdout: "Nothing to validate.", stderr: "", code: 1 }));

    const result = await readOpenSpecJson("/companions/acme", ["validate", "--json"], deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.command).toBe("openspec validate --json");
    expect(result.failure.reason).toContain("exit code 1");
  });

  test("returns a typed failure when stdout is not JSON on success", async () => {
    const { deps } = recordingDeps(() => ({ stdout: "not json", code: 0 }));

    const result = await readOpenSpecJson("/companions/acme", ["list", "--json"], deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.reason).toContain("did not return JSON");
  });

  test("returns a typed failure instead of throwing when the run rejects", async () => {
    const result = await readOpenSpecJson("/companions/acme", ["list", "--json"], {
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.reason).toContain("spawn ENOENT");
  });

  test("reports the stderr tail as the failure reason when present", async () => {
    const { deps } = recordingDeps(() => ({
      stdout: "",
      stderr: "openspec: no mate context here",
      code: 1,
    }));

    const result = await readOpenSpecJson("/companions/acme", ["list", "--json"], deps);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.reason).toContain("openspec: no mate context here");
  });
});

describe("the four collection commands", () => {
  test("listChanges reads `list --json`", async () => {
    const { deps, invocations } = recordingDeps(() => ({ stdout: '{"changes":[]}', code: 0 }));

    expect(await listChanges("/companions/acme", deps)).toEqual({
      ok: true,
      value: { changes: [] },
    });
    expect(invocations[0]?.args).toEqual(["list", "--json"]);
  });

  test("listSpecs reads `list --specs --json`", async () => {
    const { deps, invocations } = recordingDeps(() => ({ stdout: '{"specs":[]}', code: 0 }));

    expect(await listSpecs("/companions/acme", deps)).toEqual({ ok: true, value: { specs: [] } });
    expect(invocations[0]?.args).toEqual(["list", "--specs", "--json"]);
  });

  test("readAllChangeStatus reads `status --all --json`", async () => {
    const { deps, invocations } = recordingDeps(() => ({ stdout: '{"changes":[]}', code: 0 }));

    expect(await readAllChangeStatus("/companions/acme", deps)).toEqual({
      ok: true,
      value: { changes: [] },
    });
    expect(invocations[0]?.args).toEqual(["status", "--all", "--json"]);
  });

  test("validateAll reads `validate --all --json`", async () => {
    const { deps, invocations } = recordingDeps(() => ({ stdout: '{"items":[]}', code: 0 }));

    expect(await validateAll("/companions/acme", deps)).toEqual({
      ok: true,
      value: { items: [] },
    });
    expect(invocations[0]?.args).toEqual(["validate", "--all", "--json"]);
  });
});
