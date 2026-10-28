import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { stringify } from "yaml";

import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { companionRegistryPath } from "../../../lib/orchestrator/repository-link";
import { companionFrameworkConfigPath } from "../../../runtime/policy";
import { writeProjectionPair } from "../../../runtime/projection";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import {
  parseSessionContextArgs,
  runSessionContextCommand,
  sessionContextCommandDeps,
} from "./context";

const tempRoots: string[] = [];
const original = { ...sessionContextCommandDeps };
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = exitCode;
  Object.assign(sessionContextCommandDeps, original);
  for (const dir of tempRoots.splice(0)) {
    chmodTree(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A wrapped `acme-app`, linked to the registered `acme` companion, and a Mate home. */
function linkedRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-context-cmd-")));
  tempRoots.push(root);
  const repoRoot = path.join(root, "acme-app");
  const companionPath = path.join(root, "acme");
  const home = path.join(root, "home");

  fs.mkdirSync(path.dirname(repoLocalRegistryPath(repoRoot)), { recursive: true });
  fs.writeFileSync(repoLocalRegistryPath(repoRoot), "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.18.5",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      wrapperBinPath: "/w",
      reactDoctorBinPath: "/r",
      graphifyOut: "/g",
    },
  });

  fs.mkdirSync(path.dirname(companionFrameworkConfigPath(companionPath)), { recursive: true });
  fs.writeFileSync(
    companionFrameworkConfigPath(companionPath),
    'allowedAgents:\n  - claude\nsecrets:\n  deny: ["*.tfstate"]\n',
    "utf8",
  );
  fs.writeFileSync(
    companionRegistryPath(companionPath),
    stringify({ repos: [{ id: "acme-app", path: repoRoot }] }),
    "utf8",
  );

  const configPath = path.join(home, ".mate", "config.yaml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    stringify({ version: 1, companions: [{ path: companionPath }] }),
    "utf8",
  );
  sessionContextCommandDeps.configStore = () => new GlobalConfigStore(configPath);

  return { root, repoRoot, companionPath, home };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation(
    (...a: unknown[]) => void out.push(a.join(" ")),
  );
  const error = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void err.push(a.join(" ")),
  );
  const write = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string,
    cb?: () => void,
  ) => {
    out.push(String(chunk));
    cb?.();
    return true;
  }) as never);
  return {
    out,
    err,
    restore() {
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
    },
  };
}

async function run(argv: string[]) {
  const io = capture();
  try {
    await runSessionContextCommand(argv);
  } finally {
    io.restore();
  }
  return { stdout: io.out.join(""), stderr: io.err.join("\n"), exitCode: process.exitCode };
}

function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full);
      const hash = entry.isFile()
        ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")
        : "";
      entries[path.relative(dir, full)] = `${stat.mtimeMs}:${hash}`;
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries;
}

function chmodTree(dir: string, mode: number): void {
  try {
    fs.chmodSync(dir, mode);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) chmodTree(path.join(dir, entry.name), mode);
    }
  } catch {
    // best effort
  }
}

describe("parseSessionContextArgs", () => {
  test("reads --repo relative to the current folder, inline or separate", () => {
    expect(parseSessionContextArgs(["--repo", "app", "--json"], "/work")).toEqual({
      repo: "/work/app",
      json: true,
    });
    expect(parseSessionContextArgs(["--repo=/abs"], "/work")).toEqual({
      repo: "/abs",
      json: false,
    });
  });

  test("reads --repo where the system reaches it, a link before `..` followed first", () => {
    const { root, repoRoot } = linkedRepo();
    fs.mkdirSync(path.join(root, "sub"));
    fs.mkdirSync(path.join(root, "d", "acme-app"), { recursive: true });
    fs.symlinkSync(path.join(root, "sub"), path.join(root, "d", "forward"), "dir");

    const spelled = `${path.join(root, "d", "forward")}/../acme-app`;
    expect(parseSessionContextArgs(["--repo", spelled])).toEqual({ repo: repoRoot, json: false });
    expect(
      parseSessionContextArgs(["--repo", "forward/../acme-app"], path.join(root, "d")),
    ).toEqual({ repo: repoRoot, json: false });
  });

  test("rejects an unknown option and a --repo without a value", () => {
    expect(parseSessionContextArgs(["--sync"])).toEqual({
      error: "unknown session context option: --sync",
    });
    expect(parseSessionContextArgs(["--repo"])).toEqual({ error: "--repo requires a directory" });
    expect(parseSessionContextArgs(["--repo", "--json"])).toEqual({
      error: "--repo requires a directory",
    });
  });
});

describe("runSessionContextCommand", () => {
  test("prints one JSON object with the context and exits 0", async () => {
    const { repoRoot, companionPath } = linkedRepo();

    const { stdout, exitCode } = await run(["--repo", repoRoot, "--json"]);

    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const reply = JSON.parse(stdout);
    expect(Object.keys(reply).sort()).toEqual(
      ["companionPath", "policyJson", "protocol", "repositoryId", "repositoryPath"].sort(),
    );
    expect(reply.protocol).toBe(1);
    expect(reply.companionPath).toBe(companionPath);
    expect(reply.repositoryId).toBe("acme-app");
    const patterns = JSON.parse(reply.policyJson).secrets.deny.map(
      (rule: { pattern: string }) => rule.pattern,
    );
    expect(patterns).toContain("*.tfstate");
  });

  test("prints one JSON error object for a folder that is not wrapped and exits non-zero", async () => {
    const { root } = linkedRepo();
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);

    const { stdout, stderr, exitCode } = await run(["--repo", bare, "--json"]);

    expect(exitCode).toBe(1);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const reply = JSON.parse(stdout);
    expect(reply).toEqual({
      protocol: 1,
      error: { code: "not-wrapped", message: expect.any(String) },
    });
    expect(stderr).toContain("projection");
  });

  test("reports a refused companion without its path or policy", async () => {
    const { repoRoot, root } = linkedRepo();
    sessionContextCommandDeps.configStore = () =>
      new GlobalConfigStore(path.join(root, "nobody", "config.yaml"));

    const { stdout, exitCode } = await run(["--repo", repoRoot, "--json"]);

    expect(exitCode).toBe(1);
    const reply = JSON.parse(stdout);
    expect(reply.error.code).toBe("companion-not-registered");
    expect(reply.companionPath).toBeUndefined();
    expect(reply.policyJson).toBeUndefined();
  });

  test("prints one JSON error object for a bad option under --json", async () => {
    const { stdout, stderr, exitCode } = await run(["--json", "--bogus"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      protocol: 1,
      error: { code: "usage", message: "unknown session context option: --bogus" },
    });
    expect(stderr).toContain("Usage:");
  });

  test("prints one JSON usage error for --repo followed by --json", async () => {
    const { stdout, exitCode } = await run(["--repo", "--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("usage");
  });

  test("prints one JSON error object when the query fails unexpectedly", async () => {
    const { repoRoot } = linkedRepo();
    sessionContextCommandDeps.configStore = () => {
      throw new Error("acme config exploded");
    };

    const { stdout, stderr, exitCode } = await run(["--repo", repoRoot, "--json"]);

    expect(exitCode).toBe(1);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      protocol: 1,
      error: { code: "internal", message: "acme config exploded" },
    });
    expect(stderr).toContain("acme config exploded");
  });

  test("answers internal, not companion-not-registered, for malformed Mate configuration", async () => {
    const { repoRoot, home } = linkedRepo();
    const configPath = path.join(home, ".mate", "config.yaml");
    fs.writeFileSync(configPath, "version: 1\ncompanions: [\n  - path: : :\n", "utf8");

    const { stdout, exitCode } = await run(["--repo", repoRoot, "--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("internal");
  });

  test("answers internal, not repository-not-linked, for a malformed companion registry", async () => {
    const { repoRoot, companionPath } = linkedRepo();
    fs.writeFileSync(companionRegistryPath(companionPath), "repos: [\n  - id: : :\n", "utf8");

    const { stdout, exitCode } = await run(["--repo", repoRoot, "--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("internal");
  });

  test("changes no file in the repository, the companion or the Mate home", async () => {
    const { root, repoRoot, companionPath, home } = linkedRepo();
    const before = snapshot(root);
    chmodTree(root, 0o555);

    try {
      const below = path.join(repoRoot, ".mate");
      expect((await run(["--repo", below, "--json"])).exitCode).toBe(0);
      expect((await run(["--repo", repoRoot])).exitCode).toBe(0);
    } finally {
      chmodTree(root, 0o755);
    }

    expect(snapshot(root)).toEqual(before);
    for (const dir of [repoRoot, companionPath, home]) expect(fs.existsSync(dir)).toBe(true);
  });
});
