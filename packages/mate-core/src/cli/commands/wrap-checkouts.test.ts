import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { addWorktree } from "../../../test/git-checkouts";
import { linkedClone, type LinkedClone } from "../../../test/linked-clone";
import { adoptNewCheckout } from "../../lib/orchestrator/checkout-adoption";
import { runtimeDocumentDeps } from "../../lib/orchestrator/projection-runtime-documents";
import {
  companionRegistryPath,
  findRepoLocalLinkedRepository,
} from "../../lib/orchestrator/repository-link";
import { readWrapStateSync } from "../../runtime/wrap-state";
import { runUnwrapCommand } from "./unwrap";
import { runWrapCommand, type WrapCommandDependencies } from "./wrap";

const roots: string[] = [];
const originalHomeDir = runtimeDocumentDeps.homeDir;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  process.exitCode = 0;
  delete process.env.MATE_ARTIFACT_PATH;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  process.exitCode = exitCode;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A linked clone whose `~/.claude.json` writes land in its own folder, never the real home. */
async function clone(): Promise<LinkedClone> {
  const linked = await linkedClone(roots);
  const home = path.join(linked.root, "home");
  await fs.mkdir(home);
  runtimeDocumentDeps.homeDir = () => home;
  return linked;
}

function depsFor(linked: LinkedClone): WrapCommandDependencies {
  return {
    adoptNewCheckout: (folder) => adoptNewCheckout(folder, linked.store),
    resolveLinkedCompanions: async () => [{ companionPath: linked.companionPath } as never],
  };
}

async function quietly(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void out.push(args.join(" ")),
  );
  const error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void out.push(args.join(" ")),
  );
  try {
    await run();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return out.join("\n");
}

describe("mate wrap and unwrap in a worktree", () => {
  test("mate wrap adopts a new worktree, then wraps it", async () => {
    const linked = await clone();
    const worktree = addWorktree(linked.main, path.join(linked.root, "acme-fix"));

    await quietly(() => runWrapCommand([], worktree, depsFor(linked)));

    expect(process.exitCode).toBe(0);
    expect(await findRepoLocalLinkedRepository(worktree)).toEqual({ id: "acme", path: worktree });
    expect(readWrapStateSync(worktree).runtimes.size).toBeGreaterThan(0);
    expect(await fs.readFile(companionRegistryPath(linked.companionPath), "utf8")).toBe(
      linked.registry,
    );
  });

  test("mate unwrap in a worktree of a wrapped clone says the next prepare wraps it again", async () => {
    const linked = await clone();
    await quietly(() => runWrapCommand([], linked.main, depsFor(linked)));
    const worktree = addWorktree(linked.main, path.join(linked.root, "acme-fix"));
    await quietly(() => runWrapCommand([], worktree, depsFor(linked)));

    const output = await quietly(() => runUnwrapCommand([], worktree));

    expect(process.exitCode).toBe(0);
    expect(output).toContain("mate session prepare");
    expect(output).toContain(`${linked.main}, the Registered Checkout of acme`);
  });

  test("mate unwrap in the Registered Checkout says nothing about Adoption", async () => {
    const linked = await clone();
    await quietly(() => runWrapCommand([], linked.main, depsFor(linked)));

    const output = await quietly(() => runUnwrapCommand([], linked.main));

    expect(output).toContain("Unwrapped acme");
    expect(output).not.toContain("mate session prepare");
  });
});
