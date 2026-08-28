import fs2 from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { resolveForLaunch } from "../../lib/orchestrator/framework-context";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repo-local-registry";
import { runtimeDocumentDeps } from "../../lib/orchestrator/projection-runtime-documents";
import { project } from "../../lib/orchestrator/working-repo-projection";
import type { LinkedRepository } from "../../lib/orchestrator/types";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { parseWrapArgs, runWrapCommand } from "./wrap";

const tempRoots: string[] = [];
let originalExitCode: number | undefined;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalHomeDir = runtimeDocumentDeps.homeDir;

beforeEach(() => {
  originalExitCode = process.exitCode;
  delete process.env.MATE_ARTIFACT_PATH;
  /**
   * Local-scope MCP writes to the user's home; never the real one from a test.
   * One stable directory per test, so a second wrap sees what the first wrote.
   */
  const home = fs2.mkdtempSync(path.join(os.tmpdir(), "mate-home-"));
  tempRoots.push(home);
  runtimeDocumentDeps.homeDir = () => home;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  process.exitCode = originalExitCode ?? 0;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  for (const root of tempRoots.splice(0)) {
    await fs.chmod(path.join(root, "working", `.${FRAMEWORK_NAME}`), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

const projectionDir = (repoPath: string) => path.join(repoPath, `.${FRAMEWORK_NAME}`);
const yamlPath = (repoPath: string) => path.join(projectionDir(repoPath), "projection.yaml");
const envPath = (repoPath: string) => path.join(projectionDir(repoPath), "projection.env");

async function makeLinkedRepo(prefix: string): Promise<{
  repoPath: string;
  companionPath: string;
  otherCompanionPath: string;
  repository: LinkedRepository;
  store: GlobalConfigStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  const otherCompanionPath = path.join(root, "other-companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  await fs.mkdir(otherCompanionPath, { recursive: true });
  const repository: LinkedRepository = { id: "app", path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
  const store = new GlobalConfigStore(path.join(root, "config.yaml"));
  await store.register(companionPath);
  return { repoPath, companionPath, otherCompanionPath, repository, store };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void out.push(args.map(String).join(" ")),
  );
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void err.push(args.map(String).join(" ")),
  );
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe("parseWrapArgs", () => {
  test("accepts no arguments", () => {
    expect(parseWrapArgs([])).toEqual({});
  });

  test("accepts both spellings of --companion", () => {
    expect(parseWrapArgs(["--companion", "/tmp/acme"])).toEqual({ companion: "/tmp/acme" });
    expect(parseWrapArgs(["--companion=/tmp/acme"])).toEqual({ companion: "/tmp/acme" });
  });

  test("rejects a missing value and unknown options", () => {
    expect(parseWrapArgs(["--companion"])).toEqual({ error: "--companion requires a path" });
    expect(parseWrapArgs(["--companion", "--json"])).toEqual({
      error: "--companion requires a path",
    });
    expect(parseWrapArgs(["--json"])).toEqual({ error: "unknown wrap option: --json" });
  });
});

describe("runWrapCommand", () => {
  test("writes the Projection Root and reports the companion it names", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-write-");
    const { out, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(out.join("\n")).toContain(`Wrapped app at ${projectionDir(repoPath)}`);
    expect(out.join("\n")).toContain(`Companion: ${companionPath}`);
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toContain(companionPath);
    expect(await fs.readFile(envPath(repoPath), "utf8")).toContain(companionPath);
  });

  test("reports an unchanged Projection Root as already wrapped", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-idempotent-");
    await runWrapCommand([], repoPath);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");
    const { out, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain("Already wrapped");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("re-pins a different companion despite an unchanged stamp", async () => {
    const { repoPath, otherCompanionPath } = await makeLinkedRepo("wrap-repin-");
    await runWrapCommand([], repoPath);
    const { out, restore } = capture();

    try {
      await runWrapCommand(["--companion", otherCompanionPath], repoPath);
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain("Wrapped app at");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toContain(otherCompanionPath);
  });

  test("fails naming companion link when the repository has no Repository Link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wrap-unlinked-"));
    tempRoots.push(root);
    const { err, restore } = capture();

    try {
      await runWrapCommand([], root);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("not a working repository linked to a companion");
    expect(err.join("\n")).toContain(`${FRAMEWORK_NAME} companion link`);
    expect(await fs.exists(yamlPath(root))).toBe(false);
  });

  test("fails on an unknown option without writing", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-badflag-");
    const { err, restore } = capture();

    try {
      await runWrapCommand(["--json"], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown wrap option: --json");
    expect(await fs.exists(yamlPath(repoPath))).toBe(false);
  });

  test("exits non-zero on a failed write, leaving the previous projection intact", async () => {
    const { repoPath, otherCompanionPath } = await makeLinkedRepo("wrap-readonly-");
    await runWrapCommand([], repoPath);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");
    await fs.chmod(projectionDir(repoPath), 0o555);
    const { err, restore } = capture();

    try {
      await runWrapCommand(["--companion", otherCompanionPath], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("failed to write the projection for app");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("writes what a launch resolution writes", async () => {
    const { repoPath, store } = await makeLinkedRepo("wrap-equivalence-");
    await runWrapCommand([], repoPath);
    const wrapped = {
      yaml: await fs.readFile(yamlPath(repoPath), "utf8"),
      env: await fs.readFile(envPath(repoPath), "utf8"),
    };

    await fs.rm(yamlPath(repoPath));
    await fs.rm(envPath(repoPath));
    await resolveForLaunch(repoPath, store);

    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(wrapped.yaml);
    expect(await fs.readFile(envPath(repoPath), "utf8")).toBe(wrapped.env);
  });

  test("working cleanup removes what wrap wrote", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-cleanup-");
    await runWrapCommand([], repoPath);

    expect(await fs.exists(path.join(repoPath, ".claude", "settings.local.json"))).toBe(true);

    await cleanupWorkingRepository(repoPath, [companionPath]);

    expect(await fs.exists(yamlPath(repoPath))).toBe(false);
    expect(await fs.exists(envPath(repoPath))).toBe(false);
    /** Cleanup holds no list of runtime documents; the catalogue does. */
    expect(await fs.exists(path.join(repoPath, ".claude"))).toBe(false);
  });

  test("a second wrap with no intervening change modifies no file", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-unchanged-");
    await runWrapCommand([], repoPath);
    const settingsPath = path.join(repoPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    await runWrapCommand([], repoPath);

    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  });

  test("exits non-zero naming the document, leaving the written projection in place", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-doc-failure-");
    const claudeDir = path.join(repoPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.chmod(claudeDir, 0o555);
    const { err, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
      await fs.chmod(claudeDir, 0o755);
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain(path.join(".claude", "settings.local.json"));
    expect(await fs.exists(yamlPath(repoPath))).toBe(true);
  });

  /**
   * Wrapping switches the repository out of managed launches, and a successful
   * command is the only place the operator can learn that before hitting the
   * refusal.
   */
  test("says that the managed launches no longer run here", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-notice-");

    const { out, restore } = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    const printed = out.join("\n");
    expect(printed).toContain(`${FRAMEWORK_NAME} claude`);
    expect(printed).toContain(`${FRAMEWORK_NAME} unwrap`);
  });

  test("a managed launch does not reconcile the working target", async () => {
    const { repoPath, companionPath, store } = await makeLinkedRepo("wrap-launch-");
    await runWrapCommand([], repoPath);
    const settingsPath = path.join(repoPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    await project("launch", {
      repoPath,
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [] },
      globalConfigStore: store,
    });

    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  });
});
