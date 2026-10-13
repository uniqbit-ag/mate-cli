import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../../framework";
import { writeRepoLocalRegistryEntry } from "../../../lib/orchestrator/repo-local-registry";
import { runWrapPass } from "../../../lib/orchestrator/wrap-pass";
import { repoLocalDirPath } from "../../../runtime/repo-local";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  updateManifest,
  withDocument,
  type WrapRuntime,
} from "../../../runtime/runtime-document-manifest";
import {
  parseSessionPrepareArgs,
  runSessionPrepareCommand,
  sessionPrepareCommandDeps,
} from "./prepare";

const tempRoots: string[] = [];
const original = { ...sessionPrepareCommandDeps };
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = exitCode;
  Object.assign(sessionPrepareCommandDeps, original);
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function linkedRepo(): Promise<{ repoPath: string; companionPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-session-"));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  await writeRepoLocalRegistryEntry(repoPath, companionPath, { id: "acme", path: repoPath }, "git");
  return { repoPath, companionPath };
}

/** Records a wrap for each runtime the way a wrap pass would, one document apiece. */
async function recordWrap(repoPath: string, runtimes: readonly WrapRuntime[]): Promise<void> {
  const documentFor = { claude: CLAUDE_SETTINGS_DOCUMENT, opencode: OPENCODE_CONFIG_DOCUMENT };
  await updateManifest(repoPath, (manifest) =>
    runtimes.reduce((next, runtime) => withDocument(next, documentFor[runtime], []), manifest),
  );
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

describe("parseSessionPrepareArgs", () => {
  test("defaults to the current directory and the local phase", () => {
    expect(parseSessionPrepareArgs([], "/work/acme")).toEqual({
      repo: "/work/acme",
      json: false,
      sync: false,
    });
  });

  test("accepts --repo, --json and --sync", () => {
    expect(parseSessionPrepareArgs(["--repo=acme", "--json", "--sync"], "/work")).toEqual({
      repo: "/work/acme",
      json: true,
      sync: true,
    });
  });

  test("rejects an unknown option", () => {
    expect(parseSessionPrepareArgs(["--phase", "local"])).toHaveProperty("error");
    expect(parseSessionPrepareArgs(["--acme"])).toHaveProperty("error");
  });
});

describe("runSessionPrepareCommand", () => {
  test("refuses a repository wrapped for neither runtime and writes nothing", async () => {
    const { repoPath } = await linkedRepo();
    const before = await fs.readdir(repoLocalDirPath(repoPath), { recursive: true });
    const prepare = mock(async () => ({}) as never);
    sessionPrepareCommandDeps.prepareSession = prepare;
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath, "--json"]);
    } finally {
      io.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("mate wrap");
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.readdir(repoLocalDirPath(repoPath), { recursive: true })).toEqual(before);
  });

  test("prints the step outcomes as JSON for a wrapped repository", async () => {
    const { repoPath, companionPath } = await linkedRepo();
    await recordWrap(repoPath, ["claude", "opencode"]);
    sessionPrepareCommandDeps.resolveLinkedCompanions = mock(async () => [
      { companionPath } as never,
    ]);
    sessionPrepareCommandDeps.prepareSession = mock(async () => ({
      ok: true,
      mode: "local" as const,
      runtime: "opencode" as const,
      runtimes: ["opencode" as const],
      repositoryId: "acme",
      companionPath,
      steps: [{ step: "file-sync" as const, outcome: "ok" as const }],
      warnings: [],
    }));
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath, "--json"]);
    } finally {
      io.restore();
    }

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(io.out.join(""))).toMatchObject({
      ok: true,
      steps: [{ step: "file-sync", outcome: "ok" }],
    });
    expect(sessionPrepareCommandDeps.prepareSession).toHaveBeenCalledWith({
      runtime: "claude",
      runtimes: ["claude", "opencode"],
      companionPath,
      repository: expect.objectContaining({ id: "acme" }),
      mode: "local",
    });
  });

  test("prepares only the runtimes the manifest records", async () => {
    const { repoPath, companionPath } = await linkedRepo();
    await recordWrap(repoPath, ["claude"]);
    sessionPrepareCommandDeps.resolveLinkedCompanions = mock(async () => [
      { companionPath } as never,
    ]);
    sessionPrepareCommandDeps.prepareSession = mock(async () => ({
      ok: true,
      mode: "local" as const,
      runtime: "claude" as const,
      runtimes: ["claude" as const],
      repositoryId: "acme",
      companionPath,
      steps: [
        { step: "working-target" as const, outcome: "ok" as const, runtimes: ["claude" as const] },
        { step: "preflight" as const, outcome: "ok" as const, runtimes: ["claude" as const] },
      ],
      warnings: [],
    }));
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath, "--json"]);
    } finally {
      io.restore();
    }

    expect(process.exitCode).toBe(0);
    expect(sessionPrepareCommandDeps.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: "claude", runtimes: ["claude"] }),
    );
    expect(JSON.parse(io.out.join(""))).toMatchObject({
      runtimes: ["claude"],
      steps: [{ runtimes: ["claude"] }, { step: "preflight", runtimes: ["claude"] }],
    });
  });

  test("--sync runs the sync mode and keeps the failure's error out of the JSON", async () => {
    const { repoPath, companionPath } = await linkedRepo();
    await recordWrap(repoPath, ["claude", "opencode"]);
    sessionPrepareCommandDeps.resolveLinkedCompanions = mock(async () => [
      { companionPath } as never,
    ]);
    sessionPrepareCommandDeps.prepareSession = mock(async () => ({
      ok: false,
      mode: "sync" as const,
      runtime: "opencode" as const,
      runtimes: ["opencode" as const],
      repositoryId: "acme",
      companionPath,
      steps: [{ step: "preflight" as const, outcome: "failed" as const, detail: "acme" }],
      warnings: [],
      failure: new Error("acme"),
    }));
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath, "--json", "--sync"]);
    } finally {
      io.restore();
    }

    expect(sessionPrepareCommandDeps.prepareSession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "sync" }),
    );
    expect(JSON.parse(io.out.join(""))).not.toHaveProperty("failure");
  });

  test("exits non-zero when a step failed", async () => {
    const { repoPath, companionPath } = await linkedRepo();
    await recordWrap(repoPath, ["claude", "opencode"]);
    sessionPrepareCommandDeps.resolveLinkedCompanions = mock(async () => [
      { companionPath } as never,
    ]);
    sessionPrepareCommandDeps.prepareSession = mock(async () => ({
      ok: false,
      mode: "local" as const,
      runtime: "opencode" as const,
      runtimes: ["opencode" as const],
      repositoryId: "acme",
      companionPath,
      steps: [{ step: "preflight" as const, outcome: "failed" as const, detail: "acme" }],
      warnings: [],
    }));
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath]);
    } finally {
      io.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(io.out.join("\n")).toContain("preflight: failed");
  });

  test("a companion configuration warning reaches the JSON warnings and not stderr", async () => {
    const { repoPath, companionPath } = await linkedRepo();
    await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "allowedAgents:\n  - opencode\ncapabilities: []\n",
    );
    await fs.mkdir(path.join(companionPath, ".opencode"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, ".opencode", "opencode.json"),
      JSON.stringify({ instructions: ["./guide.md"] }),
    );
    await runWrapPass(companionPath, { id: "acme", path: repoPath }, { runtimes: ["opencode"] });
    const io = capture();

    try {
      await runSessionPrepareCommand(["--repo", repoPath, "--json"]);
    } finally {
      io.restore();
    }

    const reported = JSON.parse(io.out.join("")) as { warnings: string[] };
    expect(reported.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(path.join(companionPath, ".opencode", "opencode.json")),
      ]),
    );
    expect(reported.warnings.join("\n")).toContain("instructions.0");
    expect(io.err.join("\n")).not.toContain("instructions.0");
  });
});
