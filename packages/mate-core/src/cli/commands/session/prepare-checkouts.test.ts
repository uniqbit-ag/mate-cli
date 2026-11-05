import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { addWorktree } from "../../../../test/git-checkouts";
import { linkedClone, type LinkedClone } from "../../../../test/linked-clone";
import { adoptCheckout, lookUpAdoption } from "../../../lib/orchestrator/checkout-adoption";
import {
  companionRegistryPath,
  findRepoLocalLinkedRepository,
  writeRepoLocalRegistryEntry,
} from "../../../lib/orchestrator/repository-link";
import { sessionPrepareDeps } from "../../../lib/orchestrator/session-prepare";
import { readProjectionFile } from "../../../runtime/projection";
import { repoLocalDirPath } from "../../../runtime/repo-local";
import {
  CLAUDE_SETTINGS_DOCUMENT,
  OPENCODE_CONFIG_DOCUMENT,
  updateManifest,
  withDocument,
  type WrapRuntime,
} from "../../../runtime/runtime-document-manifest";
import { readWrapStateSync } from "../../../runtime/wrap-state";
import { runSessionPrepareCommand, sessionPrepareCommandDeps } from "./prepare";

const roots: string[] = [];
const original = { ...sessionPrepareCommandDeps };
const originalPrepareDeps = { ...sessionPrepareDeps };
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = exitCode;
  Object.assign(sessionPrepareCommandDeps, original);
  Object.assign(sessionPrepareDeps, originalPrepareDeps);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Records a wrap for each runtime the way a wrap pass would, one document apiece. */
async function recordWrap(repoPath: string, runtimes: readonly WrapRuntime[]): Promise<void> {
  const documentFor = { claude: CLAUDE_SETTINGS_DOCUMENT, opencode: OPENCODE_CONFIG_DOCUMENT };
  await updateManifest(repoPath, (manifest) =>
    runtimes.reduce((next, runtime) => withDocument(next, documentFor[runtime], []), manifest),
  );
}

/** A linked clone with a new sibling worktree, resolved against the clone's own global config. */
async function cloneWithWorktree(): Promise<LinkedClone & { worktree: string }> {
  const clone = await linkedClone(roots);
  sessionPrepareCommandDeps.lookUpAdoption = (folder) => lookUpAdoption(folder, clone.store);
  sessionPrepareCommandDeps.adoptCheckout = (folder, lookup) =>
    adoptCheckout(folder, lookup, clone.store);
  return { ...clone, worktree: addWorktree(clone.main, path.join(clone.root, "acme-fix")) };
}

function stubPrepare() {
  const prepare = mock(async (input: { runtime: WrapRuntime; runtimes?: WrapRuntime[] }) => ({
    ok: true,
    mode: "local" as const,
    runtime: input.runtime,
    runtimes: input.runtimes ?? [input.runtime],
    repositoryId: "acme",
    companionPath: "",
    steps: [],
    warnings: [],
  }));
  sessionPrepareCommandDeps.prepareSession = prepare as never;
  return prepare;
}

async function runQuietly(argv: string[]): Promise<string> {
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void err.push(args.join(" ")),
  );
  const write = spyOn(process.stdout, "write").mockImplementation(((
    _chunk: string,
    cb?: () => void,
  ) => {
    cb?.();
    return true;
  }) as never);
  try {
    await runSessionPrepareCommand(argv);
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return err.join("\n");
}

describe("mate session prepare in a new worktree", () => {
  test("adopts the worktree and prepares the Registered Checkout's runtimes", async () => {
    const clone = await cloneWithWorktree();
    await recordWrap(clone.main, ["claude"]);
    const prepare = stubPrepare();

    await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(process.exitCode).toBe(0);
    expect(prepare).toHaveBeenCalledWith({
      runtime: "claude",
      runtimes: ["claude"],
      companionPath: clone.companionPath,
      repository: { id: "acme", path: clone.worktree },
      mode: "local",
    });
    expect(await findRepoLocalLinkedRepository(clone.worktree)).toEqual({
      id: "acme",
      path: clone.worktree,
    });
    expect(readProjectionFile(clone.worktree)?.projection.repositoryPath).toBe(clone.worktree);
    expect(await fs.readFile(companionRegistryPath(clone.companionPath), "utf8")).toBe(
      clone.registry,
    );
  });

  test("refuses without writing when the Registered Checkout is wrapped for nothing", async () => {
    const clone = await cloneWithWorktree();
    const prepare = stubPrepare();

    const stderr = await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain("mate wrap");
    expect(prepare).not.toHaveBeenCalled();
    expect(await fs.exists(repoLocalDirPath(clone.worktree))).toBe(false);
  });

  test("an adopted worktree whose manifest records none takes the wraps again", async () => {
    const clone = await cloneWithWorktree();
    await recordWrap(clone.main, ["claude", "opencode"]);
    await writeRepoLocalRegistryEntry(
      clone.worktree,
      clone.companionPath,
      { id: "acme", path: clone.worktree },
      "git",
    );
    const prepare = stubPrepare();

    await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimes: ["claude", "opencode"],
        repository: { id: "acme", path: clone.worktree },
      }),
    );
  });

  test("a worktree with its own wrap keeps it", async () => {
    const clone = await cloneWithWorktree();
    await recordWrap(clone.main, ["claude"]);
    await writeRepoLocalRegistryEntry(
      clone.worktree,
      clone.companionPath,
      { id: "acme", path: clone.worktree },
      "git",
    );
    await recordWrap(clone.worktree, ["opencode"]);
    sessionPrepareCommandDeps.resolveLinkedCompanions = mock(async () => [
      { companionPath: clone.companionPath } as never,
    ]);
    const prepare = stubPrepare();

    await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ runtimes: ["opencode"] }));
  });

  test("with the companion lock held elsewhere, the link and projection are still written", async () => {
    const clone = await cloneWithWorktree();
    await recordWrap(clone.main, ["claude"]);
    sessionPrepareDeps.withCompanionLock = (async () => ({ acquired: false })) as never;

    await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(process.exitCode).toBe(0);
    expect(await findRepoLocalLinkedRepository(clone.worktree)).toEqual({
      id: "acme",
      path: clone.worktree,
    });
    expect(readProjectionFile(clone.worktree)?.projection.repositoryPath).toBe(clone.worktree);
    /** The wrap waits for the next prepare that gets the lock. */
    expect(readWrapStateSync(clone.worktree).runtimes.size).toBe(0);
  });

  test("a link an earlier command wrote still gets its projection with the lock held elsewhere", async () => {
    const clone = await cloneWithWorktree();
    await recordWrap(clone.main, ["claude"]);
    await writeRepoLocalRegistryEntry(
      clone.worktree,
      clone.companionPath,
      { id: "acme", path: clone.worktree },
      "git",
    );
    sessionPrepareDeps.withCompanionLock = (async () => ({ acquired: false })) as never;

    await runQuietly(["--repo", clone.worktree, "--json"]);

    expect(process.exitCode).toBe(0);
    expect(readProjectionFile(clone.worktree)?.projection.repositoryPath).toBe(clone.worktree);
  });
});
