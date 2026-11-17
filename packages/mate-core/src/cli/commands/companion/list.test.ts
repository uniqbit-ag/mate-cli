import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../../framework";
import { GlobalConfigStore } from "../../../lib/orchestrator/global-config-store";
import { companionRootedStore } from "../../../lib/orchestrator/repository-link";
import { repoLocalRegistryPath } from "../../../runtime/repo-local";
import { listCompanionContext } from "./list";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.MATE_ARTIFACT_PATH;
  delete process.env.MATE_REPO_PATH;
  delete process.env.MATE_REPO_ID;
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

interface Fixture {
  root: string;
  companion: string;
  companionTwo: string;
  acme: string;
  acmeTwo: string;
  globalStore: GlobalConfigStore;
}

/** `acme-companion` lists `acme` and `acme-two`; `acme-companion-two` exists but links nothing. */
async function makeFixture(): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "companion-list-")));
  tempRoots.push(root);
  const companion = path.join(root, "acme-companion");
  const companionTwo = path.join(root, "acme-companion-two");
  const acme = path.join(root, "acme");
  const acmeTwo = path.join(root, "acme-two");
  for (const companionPath of [companion, companionTwo]) {
    const configPath = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "type: companion\n", "utf8");
  }
  await fs.mkdir(acme, { recursive: true });
  await fs.mkdir(acmeTwo, { recursive: true });

  const globalStore = new GlobalConfigStore(path.join(root, "config.yaml"));
  await globalStore.register(companion);
  await globalStore.register(companionTwo);

  const store = companionRootedStore(companion);
  await store.registerRepository({ id: "acme", path: acme }, { companionSource: "local" });
  await store.registerRepository({ id: "acme-two", path: acmeTwo }, { companionSource: "local" });

  return { root, companion, companionTwo, acme, acmeTwo, globalStore };
}

describe("listCompanionContext in a Working Repository", () => {
  test("lists the one connected companion as active", async () => {
    const f = await makeFixture();

    const listing = await listCompanionContext(f.acmeTwo, f.globalStore);

    expect(listing).toEqual({
      workingRepository: { id: "acme-two", path: f.acmeTwo },
      companions: [{ path: f.companion, repositoryId: "acme-two", active: true }],
    });
  });

  test("lists both connected companions and marks only the resolved one", async () => {
    const f = await makeFixture();
    await companionRootedStore(f.companionTwo).registerRepository(
      { id: "acme-two", path: f.acmeTwo },
      { companionSource: "local" },
    );

    const listing = await listCompanionContext(f.acmeTwo, f.globalStore);

    expect("companions" in listing && listing.companions).toEqual([
      { path: f.companion, repositoryId: "acme-two", active: true },
      { path: f.companionTwo, repositoryId: "acme-two", active: false },
    ]);
  });

  test("lists the clone's companion from a linked worktree", async () => {
    const f = await makeFixture();
    runGit(f.acmeTwo, ["init", "-q"]);
    runGit(f.acmeTwo, [
      "-c",
      "user.name=acme",
      "-c",
      "user.email=acme@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    // Re-register so the entry records the clone's shared Git folder.
    await companionRootedStore(f.companion).registerRepository(
      { id: "acme-two", path: f.acmeTwo },
      { companionSource: "local" },
    );
    const worktree = path.join(f.root, "acme-two-fix");
    runGit(f.acmeTwo, ["worktree", "add", "-q", "-b", "fix", worktree]);

    const listing = await listCompanionContext(worktree, f.globalStore);

    expect(listing).toEqual({
      workingRepository: { id: "acme-two", path: worktree },
      companions: [{ path: f.companion, repositoryId: "acme-two", active: true }],
    });
  });

  test("marks the session's companion in a Mate-launched session", async () => {
    const f = await makeFixture();
    process.env.MATE_ARTIFACT_PATH = f.companion;
    process.env.MATE_REPO_PATH = f.acmeTwo;
    process.env.MATE_REPO_ID = "acme-two";

    const listing = await listCompanionContext(f.acmeTwo, f.globalStore);

    expect(listing).toEqual({
      workingRepository: { id: "acme-two", path: f.acmeTwo },
      companions: [{ path: f.companion, repositoryId: "acme-two", active: true }],
    });
  });

  test("leaves the repo-local registry untouched when a companion pointer is stale", async () => {
    const f = await makeFixture();
    await companionRootedStore(f.companionTwo).registerRepository(
      { id: "acme-two", path: f.acmeTwo },
      { companionSource: "local" },
    );
    await fs.rm(f.companionTwo, { recursive: true, force: true });
    const registryPath = repoLocalRegistryPath(f.acmeTwo);
    const before = await fs.readFile(registryPath, "utf8");

    const listing = await listCompanionContext(f.acmeTwo, f.globalStore);

    expect(await fs.readFile(registryPath, "utf8")).toBe(before);
    expect("companions" in listing && listing.companions).toEqual([
      { path: f.companion, repositoryId: "acme-two", active: true },
    ]);
  });
});

describe("listCompanionContext in a companion root", () => {
  test("lists every linked Working Repository", async () => {
    const f = await makeFixture();

    const listing = await listCompanionContext(f.companion, f.globalStore);

    expect("repositories" in listing && listing.companionPath).toBe(f.companion);
    expect(
      "repositories" in listing &&
        listing.repositories.map(({ id, path: repositoryPath }) => ({ id, path: repositoryPath })),
    ).toEqual([
      { id: "acme", path: f.acme },
      { id: "acme-two", path: f.acmeTwo },
    ]);
  });

  test("lists nothing for an empty registry", async () => {
    const f = await makeFixture();

    const listing = await listCompanionContext(f.companionTwo, f.globalStore);

    expect(listing).toEqual({ companionPath: f.companionTwo, repositories: [] });
  });
});
