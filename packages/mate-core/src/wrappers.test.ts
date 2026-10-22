import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { generatedHeader, renderProjectionEnv } from "./runtime/projection";
import { repoLocalDirPath, repoLocalRegistryPath } from "./runtime/repo-local";

const WRAPPER_BIN = path.resolve(import.meta.dirname, "..", "wrappers", "bin");
const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

/** Reports its cwd, its argv and every `MATE_`- and `OPENSPEC_`-prefixed variable it inherited. */
function stubBinary(name: string): string {
  const dir = makeTempDir(`mate-wrapper-stub-${name}-`);
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      'echo "cwd=$PWD"',
      'echo "args=$*"',
      'echo "graphify_out=${GRAPHIFY_OUT-}"',
      'env | grep "^MATE_" | sort | sed "s/^/mate_env=/"',
      'env | grep "^OPENSPEC_" | sort | sed "s/^/openspec_env=/"',
      "exit 0",
    ].join("\n") + "\n",
    "utf8",
  );
  fs.chmodSync(file, 0o755);
  return dir;
}

function wrapRepo(
  repoRoot: string,
  companionPath: string,
  overrides: { wrapperBinPath?: string; graphifyOut?: string } = {},
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
      graphifyOut:
        overrides.graphifyOut ?? path.join(companionPath, ".graphify", "acme", "graphify-out"),
    },
  });
  fs.mkdirSync(repoLocalDirPath(repoRoot), { recursive: true });
  fs.writeFileSync(path.join(repoLocalDirPath(repoRoot), "projection.env"), rendered, "utf8");
}

function runWrapper(
  name: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; stubDir?: string; nodeDir?: string },
): { status: number; stdout: string; stderr: string } {
  /** The harness may itself run under a launch; only what the test sets may reach the wrapper. */
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MATE_") && key !== "GRAPHIFY_OUT") env[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) env[key] = value;
  env.PATH = [WRAPPER_BIN, options.stubDir, options.nodeDir, "/usr/bin", "/bin"]
    .filter(Boolean)
    .join(path.delimiter);

  const result = spawnSync(path.join(WRAPPER_BIN, name), args, {
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
  fs.writeFileSync(path.join(companion, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");
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

    expect(result.stdout).toContain("args=templates --schema mate-v1");
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

describe("graphify wrapper", () => {
  test("takes the output path from the projection rather than recomputing it", () => {
    const repo = makeTempDir("mate-graphify-repo-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    const graphifyOut = path.join(companion, "elsewhere", "store", "graphify-out");
    wrapRepo(repo, companion, { graphifyOut });

    const result = runWrapper("graphify", ["query", "acme"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`graphify_out=${graphifyOut}`);
    expect(result.stdout).toContain(`--graph ${path.join(graphifyOut, "graph.json")}`);
  });

  test("takes the launch environment's output path and rebuilds no store layout", () => {
    const repo = makeTempDir("mate-graphify-launch-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    const graphifyOut = path.join(companion, ".graphify", "acme", "graphify-out");

    const result = runWrapper("graphify", ["query", "acme"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
      env: {
        MATE_ARTIFACT_PATH: companion,
        MATE_REPO_PATH: repo,
        MATE_REPO_ID: "acme",
        GRAPHIFY_OUT: graphifyOut,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`graphify_out=${graphifyOut}`);
    expect(fs.readFileSync(path.join(WRAPPER_BIN, "graphify"), "utf8")).not.toContain(
      "MATE_REPO_ID:-",
    );
  });

  test("extracts the working repository the projection names", () => {
    const repo = makeTempDir("mate-graphify-build-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion);

    const result = runWrapper("graphify", ["build"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
    });

    expect(result.stdout).toContain(`args=extract ${repo} --out`);
  });

  test("exports no MATE_ variable into the delegated binary", () => {
    const repo = makeTempDir("mate-graphify-noexport-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion);

    expect(
      runWrapper("graphify", ["query", "acme"], { cwd: repo, stubDir: stubBinary("graphify") })
        .stdout,
    ).not.toContain("mate_env=");
  });

  test("refuses when nothing resolves, naming mate wrap", () => {
    const bare = makeTempDir("mate-graphify-unwrapped-");

    const result = runWrapper("graphify", ["query", "acme"], {
      cwd: bare,
      stubDir: stubBinary("graphify"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mate wrap");
    expect(result.stderr).not.toContain("mate opencode");
  });

  test("refuses when the projected wrapper directory names a different install", () => {
    const repo = makeTempDir("mate-graphify-foreign-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    wrapRepo(repo, companion, { wrapperBinPath: "/some/other/install/wrappers/bin" });

    const result = runWrapper("graphify", ["query", "acme"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("mate wrap");
  });

  test("the launch environment outranks the projection and keeps its own output path", () => {
    const repo = makeTempDir("mate-graphify-outranks-");
    const launched = path.join(repo, "launched");
    const projected = path.join(repo, "projected");
    fs.mkdirSync(launched, { recursive: true });
    fs.mkdirSync(projected, { recursive: true });
    wrapRepo(repo, projected, { wrapperBinPath: "/some/other/install/wrappers/bin" });

    const result = runWrapper("graphify", ["query", "acme"], {
      cwd: repo,
      env: {
        MATE_ARTIFACT_PATH: launched,
        MATE_REPO_PATH: repo,
        GRAPHIFY_OUT: path.join(launched, "store", "graphify-out"),
      },
      stubDir: stubBinary("graphify"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`graphify_out=${path.join(launched, "store", "graphify-out")}`);
  });
});

describe("graphify wrapper secret gate", () => {
  /** The gate shim runs on node; the harness itself runs on bun. */
  const nodeBinary = spawnSync("bash", ["-lc", "command -v node"], {
    encoding: "utf8",
  }).stdout.trim();
  const nodeDir = nodeBinary ? path.dirname(nodeBinary) : undefined;
  const gated = nodeDir ? test : test.skip;

  /** A graphify stand-in that echoes its args and writes a graph with one secret file. */
  function leakyGraphify(): string {
    const dir = makeTempDir("mate-wrapper-stub-leaky-");
    const file = path.join(dir, "graphify");
    const graph = JSON.stringify({
      nodes: [
        { id: "app", source_file: "src/app.ts" },
        { id: "leak", source_file: ".env.local" },
      ],
      links: [{ source: "app", target: "leak" }],
    });
    fs.writeFileSync(
      file,
      [
        "#!/usr/bin/env bash",
        'echo "args=$*"',
        'mkdir -p "$GRAPHIFY_OUT"',
        `printf '%s' '${graph}' > "$GRAPHIFY_OUT/graph.json"`,
        "exit 3",
      ].join("\n") + "\n",
    );
    fs.chmodSync(file, 0o755);
    return dir;
  }

  function wrapped() {
    const repo = makeTempDir("mate-wrapper-gate-");
    const companion = path.join(repo, "companion");
    fs.mkdirSync(companion, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    wrapRepo(repo, companion);
    return {
      repo,
      companion,
      graphifyOut: path.join(companion, ".graphify", "acme", "graphify-out"),
    };
  }

  gated("passes the secret patterns as --exclude and writes the ignore region", () => {
    const { repo } = wrapped();

    const result = runWrapper("graphify", ["update"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
      nodeDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`args=${repo} --update --exclude .env --exclude .env.*`);
    expect(fs.readFileSync(path.join(repo, ".graphifyignore"), "utf8")).toContain(
      "# mate:secrets begin",
    );
  });

  gated("prunes secrets from the output, never stops, and keeps graphify's exit status", () => {
    const { repo, graphifyOut } = wrapped();

    const result = runWrapper("graphify", ["build"], {
      cwd: repo,
      stubDir: leakyGraphify(),
      nodeDir,
    });

    expect(result.status).toBe(3);
    expect(result.stdout).toContain("--exclude .env");
    expect(result.stderr).toContain("left out secret file .env.local");
    const graph = JSON.parse(fs.readFileSync(path.join(graphifyOut, "graph.json"), "utf8"));
    expect(graph.nodes.map((node: { id: string }) => node.id)).toEqual(["app"]);
    expect(graph.links).toEqual([]);
  });

  gated("treats a direct `<path> --update` as an extraction", () => {
    const { repo } = wrapped();

    const result = runWrapper("graphify", [".", "--update"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
      nodeDir,
    });

    expect(result.stdout).toContain("args=. --update --exclude .env");
  });

  test("warns and still runs graphify when the gate can't run", () => {
    const { repo } = wrapped();

    const result = runWrapper("graphify", ["update"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`args=${repo} --update`);
    expect(result.stdout).not.toContain("--exclude");
    expect(result.stderr).toContain("the secret gate did not run");
  });

  test("leaves queries alone", () => {
    const { repo } = wrapped();

    const result = runWrapper("graphify", ["query", "Mate"], {
      cwd: repo,
      stubDir: stubBinary("graphify"),
      nodeDir,
    });

    expect(result.stdout).not.toContain("--exclude");
    expect(fs.existsSync(path.join(repo, ".graphifyignore"))).toBe(false);
  });
});
