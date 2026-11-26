import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { generatedHeader, renderProjectionEnv } from "./runtime/projection";
import { repoLocalDirPath, repoLocalRegistryPath } from "./runtime/repo-local";

const SOURCE_WRAPPER_BIN = path.resolve(import.meta.dirname, "..", "wrappers", "bin");
const BUNDLED_OPENSPEC = path.join("node_modules", "@fission-ai", "openspec", "bin", "openspec.js");
const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

/** Copies `wrappers/` into `<root>/<packageDir>/`, as an installed package carries it; returns its `bin`. */
function installWrappers(root: string, packageDir = "."): string {
  const wrappers = path.join(root, packageDir, "wrappers");
  fs.cpSync(path.dirname(SOURCE_WRAPPER_BIN), wrappers, { recursive: true });
  return path.join(wrappers, "bin");
}

/** A package install whose bundled OpenSpec CLI is the reporting stub; the tests' wrappers run from it. */
const PACKAGE_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-wrapper-pkg-")));
const WRAPPER_BIN = installWrappers(PACKAGE_ROOT);

afterAll(() => fs.rmSync(PACKAGE_ROOT, { recursive: true, force: true }));

function writeStub(file: string, lines: string[] = REPORTING_STUB): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ["#!/usr/bin/env bash", ...lines].join("\n") + "\n", "utf8");
  fs.chmodSync(file, 0o755);
}

/** Reports its cwd, its argv and every `MATE_`- and `OPENSPEC_`-prefixed variable it inherited. */
const REPORTING_STUB = [
  'echo "cwd=$PWD"',
  'echo "args=$*"',
  'env | grep "^MATE_" | sort | sed "s/^/mate_env=/"',
  'env | grep "^OPENSPEC_" | sort | sed "s/^/openspec_env=/"',
  "exit 0",
];

/**
 * A reporting stub: `openspec` is placed where the package bundles its CLI,
 * any other name in a directory returned for `PATH`.
 */
function stubBinary(name: string): string {
  if (name === "openspec") {
    writeStub(path.join(PACKAGE_ROOT, BUNDLED_OPENSPEC));
    return path.dirname(path.join(PACKAGE_ROOT, BUNDLED_OPENSPEC));
  }
  const dir = makeTempDir(`mate-wrapper-stub-${name}-`);
  writeStub(path.join(dir, name));
  return dir;
}

function wrapRepo(
  repoRoot: string,
  companionPath: string,
  overrides: { wrapperBinPath?: string } = {},
): void {
  const registryPath = repoLocalRegistryPath(repoRoot);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n", "utf8");
  const rendered = renderProjectionEnv({
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme",
      wrapperBinPath: overrides.wrapperBinPath ?? WRAPPER_BIN,
      reactDoctorBinPath: path.join(companionPath, "react-doctor"),
    },
  });
  fs.mkdirSync(repoLocalDirPath(repoRoot), { recursive: true });
  fs.writeFileSync(path.join(repoLocalDirPath(repoRoot), "projection.env"), rendered, "utf8");
}

function runWrapper(
  name: string,
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string>;
    stubDir?: string;
    nodeDir?: string;
    wrapperBin?: string;
  },
): { status: number; stdout: string; stderr: string } {
  /** The harness may itself run under a launch; only what the test sets may reach the wrapper. */
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MATE_")) env[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value;
  const wrapperBin = options.wrapperBin ?? WRAPPER_BIN;
  env.PATH = [wrapperBin, options.stubDir, options.nodeDir, "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(path.delimiter);

  const result = spawnSync(path.join(wrapperBin, name), args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("openspec wrapper", () => {
  test("resolves the companion from the projection when the environment is empty", () => {
    const repo = makeTempDir("mate-wrapper-repo-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion);

    const result = runWrapper("openspec", ["list"], {
      cwd: repo,
      stubDir: stubBinary("openspec"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${companion}`);
    expect(result.stdout).toContain("args=list");
  });

  test("exports no MATE_ variable into the delegated binary", () => {
    const repo = makeTempDir("mate-wrapper-noexport-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion);

    const result = runWrapper("openspec", ["list"], {
      cwd: repo,
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).not.toContain("mate_env=");
  });

  test("delegates with OpenSpec telemetry and update checks off", () => {
    const repo = makeTempDir("mate-wrapper-openspec-env-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion);

    const result = runWrapper("openspec", ["status", "--change", "acme", "--json"], {
      cwd: repo,
      env: { OPENSPEC_TELEMETRY: "1", OPENSPEC_SCHEMA: "custom" },
      stubDir: stubBinary("openspec"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("openspec_env=OPENSPEC_TELEMETRY=0");
    expect(result.stdout).not.toContain("openspec_env=OPENSPEC_TELEMETRY=1");
    expect(result.stdout).toContain("openspec_env=OPENSPEC_NO_UPDATE_CHECK=1");
    expect(result.stdout).toContain("openspec_env=OPENSPEC_SCHEMA=custom");
    expect(result.stdout).not.toContain("mate_env=");
  });

  test("resolves from a nested subdirectory", () => {
    const repo = makeTempDir("mate-wrapper-nested-");
    const companion = path.join(repo, "companion");
    const nested = path.join(repo, "packages", "acme");
    fs.mkdirSync(companion, { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    wrapRepo(repo, companion);

    expect(
      runWrapper("openspec", ["list"], { cwd: nested, stubDir: stubBinary("openspec") }).stdout,
    ).toContain(`cwd=${companion}`);
  });

  test("the launch environment outranks the projection", () => {
    const repo = makeTempDir("mate-wrapper-outranks-");
    const launched = path.join(repo, "launched");
    const projected = path.join(repo, "projected");
    fs.mkdirSync(launched, { recursive: true });
    fs.mkdirSync(projected, { recursive: true });
    wrapRepo(repo, projected, { wrapperBinPath: "/some/other/install/wrappers/bin" });

    const result = runWrapper("openspec", ["list"], {
      cwd: repo,
      env: { MATE_ARTIFACT_PATH: launched },
      stubDir: stubBinary("openspec"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${launched}`);
  });

  test("refuses when nothing resolves, naming mate wrap", () => {
    const bare = makeTempDir("mate-wrapper-unwrapped-");

    const result = runWrapper("openspec", ["list"], { cwd: bare, stubDir: stubBinary("openspec") });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mate wrap");
    expect(result.stderr).not.toContain("mate claude");
  });

  test("refuses when the projected wrapper directory names a different install", () => {
    const repo = makeTempDir("mate-wrapper-foreign-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion, { wrapperBinPath: "/some/other/install/wrappers/bin" });

    const result = runWrapper("openspec", ["list"], { cwd: repo, stubDir: stubBinary("openspec") });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("/some/other/install/wrappers/bin");
    expect(result.stderr).toContain("mate wrap");
  });
});

describe("openspec wrapper finds the bundled CLI", () => {
  function launch(wrapperBin: string, stubDir?: string) {
    const companion = makeTempDir("mate-wrapper-bundled-companion-");
    return runWrapper("openspec", ["list"], {
      cwd: companion,
      env: { MATE_ARTIFACT_PATH: companion },
      stubDir,
      wrapperBin,
    });
  }

  test("ignores a global openspec earlier on PATH", () => {
    const root = makeTempDir("mate-wrapper-global-");
    const wrapperBin = installWrappers(root);
    writeStub(path.join(root, BUNDLED_OPENSPEC), ['echo "bundled"']);
    const global = makeTempDir("mate-wrapper-global-bin-");
    writeStub(path.join(global, "openspec"), ['echo "global"']);

    const result = launch(wrapperBin, global);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("bundled\n");
  });

  test("finds the CLI hoisted above an installed mate-core", () => {
    const root = makeTempDir("mate-wrapper-hoisted-");
    const wrapperBin = installWrappers(root, path.join("node_modules", "@uniqbit", "mate-core"));
    writeStub(path.join(root, BUNDLED_OPENSPEC), ['echo "hoisted"']);

    expect(launch(wrapperBin).stdout).toBe("hoisted\n");
  });

  test("finds the CLI nested under mate-core from a distribution's wrappers", () => {
    const root = makeTempDir("mate-wrapper-distribution-");
    const wrapperBin = installWrappers(root);
    writeStub(path.join(root, "node_modules", "@uniqbit", "mate-core", BUNDLED_OPENSPEC), [
      'echo "nested"',
    ]);

    expect(launch(wrapperBin).stdout).toBe("nested\n");
  });

  test("follows the runtime directory's symlink to the installed package", () => {
    const root = makeTempDir("mate-wrapper-runtime-link-");
    installWrappers(root, "package");
    writeStub(path.join(root, "package", BUNDLED_OPENSPEC), ['echo "linked"']);
    const runtime = path.join(root, "home", ".mate", "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    fs.symlinkSync(path.join(root, "package", "wrappers"), path.join(runtime, "wrappers"));

    expect(launch(path.join(runtime, "wrappers", "bin")).stdout).toBe("linked\n");
  });

  test("runs a JS entry its shebang cannot start on an explicit runtime", () => {
    const root = makeTempDir("mate-wrapper-js-runtime-");
    const wrapperBin = installWrappers(root);
    const entry = path.join(root, BUNDLED_OPENSPEC);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    // Not executable, and no `node` on PATH: only the runtime fallback can start it.
    fs.writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("runtime");\n', "utf8");
    const companion = makeTempDir("mate-wrapper-js-runtime-companion-");

    const result = runWrapper("openspec", ["list"], {
      cwd: companion,
      env: { MATE_ARTIFACT_PATH: companion },
      nodeDir: path.dirname(process.execPath),
      wrapperBin,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("runtime\n");
  });

  test("names reinstalling Mate when no bundled CLI exists, without falling back to PATH", () => {
    const root = makeTempDir("mate-wrapper-missing-");
    const wrapperBin = installWrappers(root);
    const global = makeTempDir("mate-wrapper-missing-bin-");
    writeStub(path.join(global, "openspec"), ['echo "global"']);

    const result = launch(wrapperBin, global);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("global");
    expect(result.stderr).toContain("Reinstall Mate");
  });
});

/** The Mate store pointer a projection writes, or `content` for a foreign config. */
function writePointer(repoRoot: string, content = `${generatedHeader()}\nstore: acme-companion\n`) {
  fs.mkdirSync(path.join(repoRoot, "openspec"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "openspec", "config.yaml"), content, "utf8");
}

/** A Working Repository `acme` beside its companion, wrapped, with a nested package. */
function storeFixture(): { repo: string; companion: string; nested: string } {
  const root = makeTempDir("mate-wrapper-store-");
  const repo = path.join(root, "acme");
  const companion = path.join(root, "acme-companion");
  const nested = path.join(repo, "packages", "web");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(companion, "openspec"), { recursive: true });
  fs.writeFileSync(path.join(companion, "openspec", "config.yaml"), "schema: mate-full\n", "utf8");
  wrapRepo(repo, companion);
  return { repo, companion, nested };
}

const ROOT_RESOLVING = [
  "new",
  "status",
  "instructions",
  "list",
  "show",
  "validate",
  "archive",
  "doctor",
  "context",
  "schemas",
  "view",
];

describe("openspec wrapper with a Mate store pointer", () => {
  test.each(ROOT_RESOLVING)("delegates %s from the Working Repository root", (command) => {
    const { repo, nested } = storeFixture();
    writePointer(repo);

    const result = runWrapper("openspec", [command], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${repo}\n`);
    expect(result.stderr).toBe("");
  });

  test.each(["templates", "init", "update", "store", "config"])(
    "keeps %s on the companion",
    (command) => {
      const { repo, companion, nested } = storeFixture();
      writePointer(repo);

      const result = runWrapper("openspec", [command], {
        cwd: nested,
        stubDir: stubBinary("openspec"),
      });

      expect(result.stdout).toContain(`cwd=${companion}\n`);
    },
  );

  test("templates keeps defaulting its schema from the companion config", () => {
    const { repo, nested } = storeFixture();
    writePointer(repo);

    const result = runWrapper("openspec", ["templates"], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).toContain("args=templates --schema mate-full");
  });

  test("a missing pointer keeps the companion and hints at mate wrap on stderr only", () => {
    const { companion, nested } = storeFixture();

    const result = runWrapper("openspec", ["status", "--json"], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cwd=${companion}\n`);
    expect(result.stdout).not.toContain("mate wrap");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("mate wrap");
  });

  test("a non-allowlisted command without a pointer prints no hint", () => {
    const { nested } = storeFixture();

    const result = runWrapper("openspec", ["templates"], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.stderr).toBe("");
  });

  test("a caller outside the Working Repository stays on the companion without a hint", () => {
    const { repo, companion } = storeFixture();
    writePointer(repo);

    const result = runWrapper("openspec", ["status"], {
      cwd: companion,
      env: { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).toContain(`cwd=${companion}\n`);
    expect(result.stderr).toBe("");
  });

  test("a foreign config stays on the companion without a hint", () => {
    const { repo, companion, nested } = storeFixture();
    writePointer(repo, "schema: spec-driven\n");

    const result = runWrapper("openspec", ["status"], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).toContain(`cwd=${companion}\n`);
    expect(result.stderr).toBe("");
  });

  test("the launch environment's repository outranks the projection's", () => {
    const { repo, companion, nested } = storeFixture();
    writePointer(repo);
    const other = makeTempDir("mate-wrapper-other-repo-");

    const result = runWrapper("openspec", ["status"], {
      cwd: nested,
      env: { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: other },
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).toContain(`cwd=${companion}\n`);
  });

  test("the launch environment alone delegates from its repository", () => {
    const { repo, companion, nested } = storeFixture();
    writePointer(repo);
    fs.rmSync(repoLocalDirPath(repo), { recursive: true, force: true });

    const result = runWrapper("openspec", ["status"], {
      cwd: nested,
      env: { MATE_ARTIFACT_PATH: companion, MATE_REPO_PATH: repo },
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).toContain(`cwd=${repo}\n`);
  });

  test("exports no MATE_ variable when delegating from the repository", () => {
    const { repo, nested } = storeFixture();
    writePointer(repo);

    const result = runWrapper("openspec", ["status"], {
      cwd: nested,
      stubDir: stubBinary("openspec"),
    });

    expect(result.stdout).not.toContain("mate_env=");
  });
});
