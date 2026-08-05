import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

import { parsePackageSpec, runPluginInstallCommand } from "./install";

const tempRoots: string[] = [];
let originalArtifactPath: string | undefined;
let originalExitCode: number | undefined;
let stderrWrites: string[];
let originalStderrWrite: typeof process.stderr.write;
let logs: string[];
let originalLog: typeof console.log;

async function makeRoot(configYaml: string[]): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-install-cmd-"));
  tempRoots.push(rootPath);
  const configDir = path.join(rootPath, ".mate", "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, "framework.yaml"),
    [...configYaml, ""].join("\n"),
    "utf8",
  );
  return rootPath;
}

async function makeCompanion(pluginsYaml: string[] = []): Promise<string> {
  return makeRoot(["allowedAgents: []", ...pluginsYaml]);
}

async function makeHub(): Promise<string> {
  return makeRoot(["type: hub", "hub:", "  companions: []"]);
}

async function readFrameworkYaml(companionPath: string): Promise<{ plugins?: unknown[] }> {
  const raw = await fs.readFile(
    path.join(companionPath, ".mate", "config", "framework.yaml"),
    "utf8",
  );
  return parse(raw) as { plugins?: unknown[] };
}

const fakeInstall = (resolveTo: (pkg: string) => string) => ({
  runNpmInstall: async (workspaceRoot: string) => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const pkg of Object.keys(manifest.dependencies)) {
      const root = path.join(workspaceRoot, "node_modules", ...pkg.split("/"));
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: pkg, version: resolveTo(pkg) }),
        "utf8",
      );
    }
    return { ok: true };
  },
});

beforeEach(() => {
  originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  stderrWrites = [];
  originalStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
});

afterEach(async () => {
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  process.exitCode = originalExitCode;
  process.stderr.write = originalStderrWrite;
  console.log = originalLog;
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parsePackageSpec", () => {
  test("scoped package with a version", () => {
    expect(parsePackageSpec("@acme/tool@1.2.0")).toEqual({
      package: "@acme/tool",
      version: "1.2.0",
    });
  });

  test("scoped package with no version defaults to latest", () => {
    expect(parsePackageSpec("@acme/tool")).toEqual({ package: "@acme/tool", version: "latest" });
  });

  test("unscoped package with a version", () => {
    expect(parsePackageSpec("plain-tool@1.0.0")).toEqual({
      package: "plain-tool",
      version: "1.0.0",
    });
  });
});

describe("runPluginInstallCommand", () => {
  test("usage error when no package is given", async () => {
    const ok = await runPluginInstallCommand([]);
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join(" ")).toContain("usage");
  });

  test("requires a companion or hub context", async () => {
    process.env.MATE_ARTIFACT_PATH = "";
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-install-nocompanion-"));
    tempRoots.push(cwd);
    const ok = await runPluginInstallCommand(["@acme/tool@1.0.0"], { cwd });
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join(" ")).toContain("companion or hub context");
  });

  test("declares and installs into a hub root", async () => {
    const hubPath = await makeHub();
    process.env.MATE_ARTIFACT_PATH = hubPath;

    const ok = await runPluginInstallCommand(["@acme/custom-plugin@1.2.0"], {
      installDeps: fakeInstall(() => "1.2.0"),
      setupHub: async () => {},
    });

    expect(ok).toBe(true);
    const config = await readFrameworkYaml(hubPath);
    expect(config.plugins).toEqual([{ package: "@acme/custom-plugin", version: "1.2.0" }]);
    expect(logs.join(" ")).toContain("installed plugin @acme/custom-plugin@1.2.0");
  });

  test("declares a fresh package in framework.yaml and installs it", async () => {
    const companionPath = await makeCompanion();
    process.env.MATE_ARTIFACT_PATH = companionPath;

    const ok = await runPluginInstallCommand(["@acme/custom-plugin@1.2.0"], {
      installDeps: fakeInstall(() => "1.2.0"),
    });

    expect(ok).toBe(true);
    const config = await readFrameworkYaml(companionPath);
    expect(config.plugins).toEqual([{ package: "@acme/custom-plugin", version: "1.2.0" }]);
    expect(logs.join(" ")).toContain("installed plugin @acme/custom-plugin@1.2.0");
  });

  test("updates the declared version when the package is already declared", async () => {
    const companionPath = await makeCompanion([
      "plugins:",
      '  - package: "@acme/custom-plugin"',
      '    version: "^1.0.0"',
    ]);
    process.env.MATE_ARTIFACT_PATH = companionPath;

    await runPluginInstallCommand(["@acme/custom-plugin@2.0.0"], {
      installDeps: fakeInstall(() => "2.0.0"),
    });

    const config = await readFrameworkYaml(companionPath);
    expect(config.plugins).toEqual([{ package: "@acme/custom-plugin", version: "2.0.0" }]);
  });

  test("re-running with the same declared version does not rewrite framework.yaml", async () => {
    const companionPath = await makeCompanion();
    process.env.MATE_ARTIFACT_PATH = companionPath;
    await runPluginInstallCommand(["@acme/custom-plugin@1.0.0"], {
      installDeps: fakeInstall(() => "1.0.0"),
    });
    const before = await fs.stat(path.join(companionPath, ".mate", "config", "framework.yaml"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runPluginInstallCommand(["@acme/custom-plugin@1.0.0"], {
      installDeps: fakeInstall(() => "1.0.0"),
    });
    const after = await fs.stat(path.join(companionPath, ".mate", "config", "framework.yaml"));

    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("a failed install reports the failure and the registry config hint", async () => {
    const companionPath = await makeCompanion();
    process.env.MATE_ARTIFACT_PATH = companionPath;

    const ok = await runPluginInstallCommand(["@acme/broken@1.0.0"], {
      installDeps: { runNpmInstall: async () => ({ ok: false, detail: "registry unreachable" }) },
    });

    expect(ok).toBe(false);
    expect(stderrWrites.join(" ")).toContain("registry unreachable");
    expect(stderrWrites.join(" ")).toContain("npm config set");
  });
});
