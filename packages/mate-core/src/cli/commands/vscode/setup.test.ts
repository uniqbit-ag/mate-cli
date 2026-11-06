import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runVscodeSetupCommand, type InstalledExtension, type VscodeSetupDeps } from "./setup";
import { resolveVsix, VSIX_FILE, type VsixResolverDeps } from "./vsix";

let exitCode: typeof process.exitCode;
let cacheRoot: string;

beforeEach(async () => {
  exitCode = process.exitCode;
  process.exitCode = 0;
  cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "acme-vsix-"));
});

afterEach(async () => {
  process.exitCode = exitCode;
  await fs.rm(cacheRoot, { recursive: true, force: true });
});

function vsixDeps(overrides: Partial<VsixResolverDeps> = {}) {
  const calls: string[] = [];
  const deps: VsixResolverDeps = {
    exists: async () => false,
    pack: async (spec, destination) => {
      calls.push(`pack ${spec}`);
      return path.join(destination, "acme.tgz");
    },
    extract: async (tarball, target) => {
      calls.push(`extract ${path.basename(tarball)} -> ${path.basename(target)}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

function setupDeps(
  binaries: Partial<Record<"code" | "cursor", string>>,
  ok: boolean | Record<string, boolean> = true,
  extensions: Record<string, string[] | null> = {},
) {
  const installs: string[] = [];
  const { deps: vsix } = vsixDeps({ exists: async () => true });
  const deps: VscodeSetupDeps = {
    resolveEditor: (cli) => binaries[cli] ?? null,
    install: (binary, file) => {
      installs.push(`${binary} ${file}`);
      const succeeded = typeof ok === "boolean" ? ok : (ok[binary] ?? true);
      return { ok: succeeded, output: succeeded ? "" : "boom" };
    },
    installedExtensions: (binary) => {
      const lines = binary in extensions ? extensions[binary]! : [];
      return (
        lines?.map((line): InstalledExtension => {
          const [id, version] = line.split("@");
          return { id: id!, version };
        }) ?? null
      );
    },
    vsix,
    version: "1.2.3",
  };
  return { deps, installs };
}

async function run(argv: string[], deps: VscodeSetupDeps) {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void out.push(a.join(" ")),
  );
  const error = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void err.push(a.join(" ")),
  );
  try {
    await runVscodeSetupCommand(argv, deps);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return { out: out.join("\n"), err: err.join("\n"), code: process.exitCode };
}

describe("resolveVsix", () => {
  test("downloads the exact version when nothing is cached", async () => {
    const { deps, calls } = vsixDeps();
    const file = await resolveVsix({ version: "1.2.3", cacheDir: cacheRoot }, deps);
    expect(file).toBe(path.join(cacheRoot, VSIX_FILE));
    expect(calls).toEqual(["pack @uniqbit/mate-vscode@1.2.3", `extract acme.tgz -> ${VSIX_FILE}`]);
  });

  test("reuses a cached copy", async () => {
    const { deps, calls } = vsixDeps({ exists: async () => true });
    await resolveVsix({ version: "1.2.3", cacheDir: cacheRoot }, deps);
    expect(calls).toEqual([]);
  });

  test("--vsix skips the download", async () => {
    const { deps, calls } = vsixDeps({ exists: async (file) => file === "/acme/mate-vscode.vsix" });
    expect(await resolveVsix({ vsix: "/acme/mate-vscode.vsix", version: "1.2.3" }, deps)).toBe(
      "/acme/mate-vscode.vsix",
    );
    expect(calls).toEqual([]);
  });

  test("a failed download names the version and --vsix", async () => {
    const { deps } = vsixDeps({
      pack: async () => {
        throw new Error("E404");
      },
    });
    const error = await resolveVsix({ version: "1.2.3", cacheDir: cacheRoot }, deps).catch(
      (caught: Error) => caught,
    );
    expect((error as Error).message).toContain("@uniqbit/mate-vscode@1.2.3");
    expect((error as Error).message).toContain("--vsix");
  });
});

describe("mate vscode setup", () => {
  test("installs into both editors", async () => {
    const { deps, installs } = setupDeps({ code: "/bin/code", cursor: "/bin/cursor" });
    const result = await run([], deps);
    expect(result.code).toBe(0);
    expect(installs.map((line) => line.split(" ")[0])).toEqual(["/bin/code", "/bin/cursor"]);
    expect(result.out).toContain("VS Code: installed");
    expect(result.out).toContain("Cursor: installed");
    expect(result.out).not.toContain("Continuing");
  });

  test("reports the version the editor lists after the install", async () => {
    const { deps } = setupDeps({ code: "/bin/code" }, true, {
      "/bin/code": ["acme.other@9.9.9", "uniqbit.mate@1.2.3"],
    });
    const result = await run([], deps);
    expect(result.out).toContain("VS Code: installed v1.2.3");
  });

  test("a --vsix build reports its listed version, not the CLI version", async () => {
    const { deps } = setupDeps({ code: "/bin/code" }, true, {
      "/bin/code": ["uniqbit.mate@1.2.4-dev"],
    });
    const result = await run(["--vsix", "/acme/local.vsix"], deps);
    expect(result.out).toContain("VS Code: installed v1.2.4-dev");
    expect(result.out).not.toContain("v1.2.3");
  });

  test("falls back to the CLI version when the listing fails", async () => {
    const { deps } = setupDeps({ code: "/bin/code" }, true, { "/bin/code": null });
    const result = await run([], deps);
    expect(result.code).toBe(0);
    expect(result.out).toContain("VS Code: installed v1.2.3");
  });

  test("closing line names the version and only the editors that installed", async () => {
    const { deps } = setupDeps(
      { code: "/bin/code", cursor: "/bin/cursor" },
      { "/bin/cursor": false },
      { "/bin/code": ["uniqbit.mate@1.2.3"] },
    );
    const result = await run([], deps);
    expect(result.out).toContain("Mate extension v1.2.3 installed in VS Code.");
    expect(result.out.trimEnd().split("\n").at(-1)).toBe(
      "Reload open editor windows to load the Mate sidebar.",
    );
  });

  test("Cursor failing after VS Code says setup continues with VS Code", async () => {
    const { deps } = setupDeps(
      { code: "/bin/code", cursor: "/bin/cursor" },
      { "/bin/cursor": false },
    );
    const result = await run([], deps);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n").map((line) => line.trim());
    expect(lines.indexOf("Continuing with VS Code.")).toBe(
      lines.indexOf("Cursor: failed — boom") + 1,
    );
  });

  test("VS Code failing before Cursor says setup continues with Cursor", async () => {
    const { deps } = setupDeps(
      { code: "/bin/code", cursor: "/bin/cursor" },
      { "/bin/code": false },
    );
    const result = await run([], deps);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n").map((line) => line.trim());
    expect(lines.slice(0, 3)).toEqual([
      "VS Code: failed — boom",
      "Continuing with Cursor.",
      "Cursor: installed v1.2.3",
    ]);
  });

  test("every editor failing prints no continuing line", async () => {
    const { deps } = setupDeps({ code: "/bin/code", cursor: "/bin/cursor" }, false);
    const result = await run([], deps);
    expect(result.code).toBe(1);
    expect(result.out).not.toContain("Continuing");
  });

  test("--editor restricts to one editor", async () => {
    const { deps, installs } = setupDeps({ code: "/bin/code", cursor: "/bin/cursor" });
    await run(["--editor", "cursor"], deps);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toStartWith("/bin/cursor");
  });

  test("unknown editor exits non-zero naming the accepted values", async () => {
    const { deps, installs } = setupDeps({ code: "/bin/code" });
    const result = await run(["--editor", "vim"], deps);
    expect(result.code).toBe(1);
    expect(result.err).toContain("code or cursor");
    expect(installs).toEqual([]);
  });

  test("no editor CLI exits non-zero with a PATH hint", async () => {
    const { deps } = setupDeps({});
    const result = await run([], deps);
    expect(result.code).toBe(1);
    expect(result.err).toContain("PATH");
  });

  test("all installs failing exits non-zero", async () => {
    const { deps } = setupDeps({ code: "/bin/code" }, false);
    const result = await run([], deps);
    expect(result.code).toBe(1);
    expect(result.out).toContain("VS Code: failed — boom");
  });

  test("reports an editor that is not found", async () => {
    const { deps } = setupDeps({ code: "/bin/code" });
    const result = await run([], deps);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Cursor: not found");
  });

  test("--vsix is passed to the editor", async () => {
    const { deps, installs } = setupDeps({ code: "/bin/code" });
    await run(["--vsix", "/acme/local.vsix"], deps);
    expect(installs).toEqual(["/bin/code /acme/local.vsix"]);
  });

  test("a download failure exits non-zero", async () => {
    const { deps } = setupDeps({ code: "/bin/code" });
    deps.vsix = vsixDeps({
      pack: async () => {
        throw new Error("offline");
      },
    }).deps;
    const result = await run([], { ...deps, version: "0.0.0-acme" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--vsix");
  });

  test("--if-installed updates only editors that have the extension", async () => {
    const { deps, installs } = setupDeps({ code: "/bin/code", cursor: "/bin/cursor" }, true, {
      "/bin/code": ["acme.other@1.0.0", "Uniqbit.Mate@1.2.2"],
      "/bin/cursor": ["acme.other@1.0.0"],
    });
    const result = await run(["--if-installed"], deps);
    expect(result.code).toBe(0);
    expect(installs.map((entry) => entry.split(" ")[0])).toEqual(["/bin/code"]);
  });

  test("--if-installed without the extension or any editor does nothing", async () => {
    const none = setupDeps({ code: "/bin/code" }, true, { "/bin/code": null });
    expect(await run(["--if-installed"], none.deps)).toEqual({ out: "", err: "", code: 0 });
    expect(none.installs).toEqual([]);

    const noEditor = setupDeps({});
    expect((await run(["--if-installed"], noEditor.deps)).code).toBe(0);
  });
});
