import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  locateOpenSpec,
  OPENSPEC_BIN_OVERRIDE_ENV,
  OPENSPEC_ENV,
  openSpecCliDeps,
  resolveOpenSpec,
  runOpenSpec,
} from "./openspec-cli";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SOURCE_WRAPPERS = path.join(PACKAGE_ROOT, "wrappers");
const OPENSPEC_PACKAGE = path.join("node_modules", "@fission-ai", "openspec");
const MATE_CORE = path.join("node_modules", "@uniqbit", "mate-core");

const tempRoots: string[] = [];
const originalDeps = { ...openSpecCliDeps };

afterEach(() => {
  Object.assign(openSpecCliDeps, originalDeps);
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function writeExecutable(file: string, lines: string[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ["#!/usr/bin/env bash", ...lines].join("\n") + "\n", "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

/** An installed `@fission-ai/openspec` under `dir` whose CLI prints its own path. */
function installOpenSpec(dir: string, version = "9.9.9"): string {
  const pkg = path.join(dir, OPENSPEC_PACKAGE);
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@fission-ai/openspec", version, exports: { ".": "./dist/index.js" } }),
  );
  fs.writeFileSync(path.join(pkg, "dist", "index.js"), "");
  return writeExecutable(path.join(pkg, "bin", "openspec.js"), ['echo "$0"']);
}

/** Node's resolution as seen from an installed mate-core's `src/lib`. */
function resolveFrom(coreRoot: string): (id: string) => string {
  return createRequire(path.join(coreRoot, "src", "lib", "openspec-cli.ts")).resolve;
}

function stubCli(lines: string[]): void {
  const bin = writeExecutable(path.join(makeTempDir("acme-openspec-stub-"), "openspec"), lines);
  openSpecCliDeps.locate = () => ({ bin });
}

describe("resolveOpenSpec", () => {
  test("resolves the bundled CLI at the version mate-core pins", () => {
    const location = resolveOpenSpec();
    if (!("bin" in location)) throw new Error(location.missing);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    expect(path.basename(location.bin)).toBe("openspec.js");
    expect(location.version).toBe(manifest.dependencies["@fission-ai/openspec"]);
    const printed = execFileSync(location.bin, ["--version"], {
      encoding: "utf8",
      env: { ...process.env, ...OPENSPEC_ENV },
    });
    expect(printed.trim()).toBe(location.version!);
  });

  test("finds the CLI hoisted beside mate-core", () => {
    const root = makeTempDir("acme-openspec-hoisted-");
    const bin = installOpenSpec(root);

    expect(resolveOpenSpec(resolveFrom(path.join(root, MATE_CORE)), {})).toEqual({
      bin,
      version: "9.9.9",
    });
  });

  test("finds the CLI nested under mate-core first", () => {
    const root = makeTempDir("acme-openspec-nested-");
    installOpenSpec(root, "1.0.0");
    const nested = installOpenSpec(path.join(root, MATE_CORE));

    expect(resolveOpenSpec(resolveFrom(path.join(root, MATE_CORE)), {})).toEqual({
      bin: nested,
      version: "9.9.9",
    });
  });

  test("names reinstalling Mate when the package is missing", () => {
    const resolve = () => {
      throw new Error("Cannot find module '@fission-ai/openspec'");
    };

    expect(resolveOpenSpec(resolve, {})).toEqual({
      missing: expect.stringMatching(/Reinstall Mate/),
    });
  });

  test("names reinstalling Mate when the package lacks its binary", () => {
    const root = makeTempDir("acme-openspec-no-bin-");
    fs.rmSync(installOpenSpec(root));

    expect(resolveOpenSpec(resolveFrom(path.join(root, MATE_CORE)), {})).toEqual({
      missing: expect.stringMatching(/openspec\.js\. Reinstall Mate/),
    });
  });

  test("honors the test-only override, without a version when it has no manifest", () => {
    const resolve = () => "/acme/unused";

    expect(resolveOpenSpec(resolve, { [OPENSPEC_BIN_OVERRIDE_ENV]: "/acme/openspec" })).toEqual({
      bin: "/acme/openspec",
      version: undefined,
    });
  });
});

describe("the wrapper and Mate resolve the same CLI", () => {
  /** Installs mate-core with its wrappers under `root`; returns the core root. */
  function installMateCore(root: string): string {
    const coreRoot = path.join(root, MATE_CORE);
    fs.cpSync(SOURCE_WRAPPERS, path.join(coreRoot, "wrappers"), { recursive: true });
    return coreRoot;
  }

  function wrapperResolves(coreRoot: string, env: Record<string, string> = {}): string {
    const companion = makeTempDir("acme-openspec-companion-");
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("MATE_")),
    );
    const result = spawnSync(path.join(coreRoot, "wrappers", "bin", "openspec"), ["list"], {
      cwd: companion,
      encoding: "utf8",
      env: { ...inherited, MATE_ARTIFACT_PATH: companion, ...env },
    });
    expect(result.stderr).toBe("");
    return result.stdout.trim();
  }

  function mateResolves(coreRoot: string, env: Record<string, string> = {}): string {
    const location = resolveOpenSpec(resolveFrom(coreRoot), env);
    if (!("bin" in location)) throw new Error(location.missing);
    return location.bin;
  }

  test.each(["hoisted", "nested"])("%s layout", (layout) => {
    const root = makeTempDir(`acme-openspec-parity-${layout}-`);
    const coreRoot = installMateCore(root);
    const bin = installOpenSpec(layout === "nested" ? coreRoot : root);

    expect(wrapperResolves(coreRoot)).toBe(bin);
    expect(mateResolves(coreRoot)).toBe(bin);
  });

  test("with the test-only override", () => {
    const root = makeTempDir("acme-openspec-parity-override-");
    const coreRoot = installMateCore(root);
    installOpenSpec(root);
    const standIn = writeExecutable(path.join(makeTempDir("acme-stand-in-"), "openspec"), [
      'echo "$0"',
    ]);
    const env = { [OPENSPEC_BIN_OVERRIDE_ENV]: standIn };

    expect(wrapperResolves(coreRoot, env)).toBe(standIn);
    expect(mateResolves(coreRoot, env)).toBe(standIn);
  });
});

describe("locateOpenSpec", () => {
  test("answers through the in-process seam", () => {
    openSpecCliDeps.locate = () => ({ missing: "acme missing" });

    expect(locateOpenSpec()).toEqual({ missing: "acme missing" });
  });
});

describe("runOpenSpec", () => {
  test("merges OPENSPEC_ENV over the process environment and captures output", async () => {
    stubCli([
      'echo "cwd=$PWD args=$*"',
      'echo "telemetry=$OPENSPEC_TELEMETRY update=$OPENSPEC_NO_UPDATE_CHECK path=${PATH:+set}"',
      'echo "oops" >&2',
      "exit 3",
    ]);
    const cwd = makeTempDir("acme-openspec-cwd-");

    const run = await runOpenSpec(["list", "--json"], { cwd });

    expect(run).toEqual({
      code: 3,
      stdout: `cwd=${cwd} args=list --json\ntelemetry=0 update=1 path=set\n`,
      stderr: "oops\n",
    });
  });

  test("returns only Mate's own messages when the output is inherited", async () => {
    stubCli(['echo "to the terminal"']);

    const run = await runOpenSpec(["list"], { cwd: os.tmpdir(), stdio: "inherit" });

    expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("kills a child that outlives its timeout", async () => {
    stubCli(["exec sleep 5"]);

    const run = await runOpenSpec(["list"], { cwd: os.tmpdir(), timeout: 100 });

    expect(run.code).toBeNull();
  });

  test("answers the reinstall message without spawning when the CLI is missing", async () => {
    openSpecCliDeps.locate = () => ({
      missing: "bundled OpenSpec CLI is missing. Reinstall Mate.",
    });

    expect(await runOpenSpec(["list"], { cwd: os.tmpdir() })).toEqual({
      code: 1,
      stdout: "",
      stderr: "bundled OpenSpec CLI is missing. Reinstall Mate.",
      missing: true,
    });
  });

  test("runs a JS entry on the current runtime, not through its shebang or exec bit", async () => {
    const bin = path.join(makeTempDir("acme-openspec-js-"), "openspec.js");
    fs.writeFileSync(
      bin,
      "#!/acme/no-such-interpreter\nprocess.stdout.write(process.argv.slice(2).join(' '));\n",
      { mode: 0o644 },
    );
    openSpecCliDeps.locate = () => ({ bin });

    const run = await runOpenSpec(["list", "--json"], { cwd: os.tmpdir() });

    expect(run).toEqual({ code: 0, stdout: "list --json", stderr: "" });
  });

  test("answers a start failure instead of rejecting", async () => {
    openSpecCliDeps.locate = () => ({ bin: "/acme/does-not-exist/openspec" });

    const run = await runOpenSpec(["list"], { cwd: os.tmpdir() });

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/^failed to run openspec: /);
  });
});
