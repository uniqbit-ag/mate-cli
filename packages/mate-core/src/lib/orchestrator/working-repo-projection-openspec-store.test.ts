import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  openSpecRegistryPath,
  stubOpenSpec,
  writeOpenSpecRegistry,
} from "../../../test/openspec-store-stub";
import { TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES } from "../../tools/setup/capabilities/tokensave-shared";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { checkStoreRegistration, openSpecStoreDeps } from "./openspec-store";
import { generatedHeader } from "../../runtime/projection";
import type { ProjectionEntryOutcome } from "./projection-types";
import { writeRepoLocalRegistryEntry } from "./repository-link";
import type { FrameworkConfig, LinkedRepository } from "./types";
import { project, unproject } from "./working-repo-projection";

const tempRoots: string[] = [];
const originalDeps = { ...openSpecStoreDeps };

interface Fixture {
  root: string;
  repoPath: string;
  companionPath: string;
  repository: LinkedRepository;
  dataHome: string;
  calls: () => Promise<string[]>;
}

/** A Git Working Repository with one commit, and a companion that is an OpenSpec root. */
async function makeFixture(options: { registerFails?: string } = {}): Promise<Fixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openspec-entries-")));
  tempRoots.push(root);
  const repoPath = path.join(root, "acme");
  const companionPath = path.join(root, "acme-companion");
  const dataHome = path.join(root, "data");
  await fs.mkdir(path.join(repoPath, "packages", "web"), { recursive: true });
  await fs.mkdir(path.join(companionPath, "openspec"), { recursive: true });
  await fs.writeFile(path.join(companionPath, "openspec", "config.yaml"), "schema: mate-v1\n");
  await fs.writeFile(path.join(repoPath, "README.md"), "acme\n");
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  execFileSync("git", ["add", "-A"], { cwd: repoPath });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoPath });
  const repository: LinkedRepository = { id: "acme", path: repoPath };
  const stub = await stubOpenSpec(
    root,
    dataHome,
    options.registerFails ? { stderr: options.registerFails } : {},
  );
  openSpecStoreDeps.env = () => ({ ...process.env, XDG_DATA_HOME: dataHome });
  openSpecStoreDeps.resolveBinary = () => stub.bin;
  return { root, repoPath, companionPath, repository, dataHome, calls: stub.calls };
}

function projectSession(fixture: Fixture) {
  return project("session", {
    repoPath: fixture.repoPath,
    companionPath: fixture.companionPath,
    repository: fixture.repository,
  });
}

function outcomeOf(outcomes: ProjectionEntryOutcome[], id: string): ProjectionEntryOutcome {
  const found = outcomes.find((outcome) => outcome.id === id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found;
}

const excludePath = (fixture: Fixture) => path.join(fixture.repoPath, ".git", "info", "exclude");
const pointerPath = (fixture: Fixture) => path.join(fixture.repoPath, "openspec", "config.yaml");

async function excludeLines(fixture: Fixture): Promise<string[]> {
  return (await fs.readFile(excludePath(fixture), "utf8")).split("\n");
}

function gitStatus(repoPath: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repoPath,
    encoding: "utf8",
  });
}

/** Every file below `dir` with its bytes; Git's object store is not the repository's content. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, full);
    if (relative.startsWith(".git") && relative !== path.join(".git", "info", "exclude")) continue;
    // oxlint-disable-next-line no-await-in-loop -- a test fixture of a handful of files
    files[relative] = await fs.readFile(full, "utf8");
  }
  return files;
}

beforeEach(() => {
  Object.assign(openSpecStoreDeps, originalDeps);
});

afterEach(async () => {
  Object.assign(openSpecStoreDeps, originalDeps);
  for (const dir of tempRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("openspec-store-exclude", () => {
  test("keeps the exclusion line while the repository is eligible", async () => {
    const fixture = await makeFixture();
    const result = await projectSession(fixture);

    expect(outcomeOf(result.outcomes, "openspec-store-exclude").state).toBe("written");
    expect(await excludeLines(fixture)).toContain("/openspec/");
  });

  test("replaces the earlier file-only exclusion line", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(path.dirname(excludePath(fixture)), { recursive: true });
    await fs.appendFile(excludePath(fixture), "/openspec/config.yaml\n");

    await projectSession(fixture);

    const lines = await excludeLines(fixture);
    expect(lines).toContain("/openspec/");
    expect(lines).not.toContain("/openspec/config.yaml");
  });

  test("hides everything under openspec/, not only the pointer", async () => {
    const fixture = await makeFixture();
    await projectSession(fixture);
    await fs.writeFile(path.join(fixture.repoPath, "openspec", "stray.md"), "x\n");

    expect(gitStatus(fixture.repoPath)).not.toContain("openspec");
  });

  test("writes no exclusion line into a repository with its own planning root", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(path.join(fixture.repoPath, "openspec", "changes"), { recursive: true });

    await projectSession(fixture);

    expect(await excludeLines(fixture)).not.toContain("/openspec/");
  });

  test("and capability-excludes never strip each other's lines", async () => {
    const fixture = await makeFixture();
    const config = { capabilities: [{ name: "tokensave" }] } as FrameworkConfig;

    await projectSession(fixture);
    await project("launch", {
      repoPath: fixture.repoPath,
      companionPath: fixture.companionPath,
      repository: fixture.repository,
      config,
    });
    await projectSession(fixture);

    const lines = await excludeLines(fixture);
    expect(lines).toContain("/openspec/");
    for (const entry of TOKENSAVE_WORKING_REPO_EXCLUDE_ENTRIES) expect(lines).toContain(entry);
  });
});

describe("openspec-store-pointer", () => {
  test("registers the companion, then writes a pointer Git does not see", async () => {
    const fixture = await makeFixture();
    const result = await projectSession(fixture);

    expect(outcomeOf(result.outcomes, "openspec-store-pointer").state).toBe("written");
    expect(await fs.readFile(pointerPath(fixture), "utf8")).toBe(
      `${generatedHeader()}\nstore: acme-companion\n`,
    );
    expect(await checkStoreRegistration(fixture.companionPath, "acme-companion")).toEqual({
      state: "registered",
    });
    expect(gitStatus(fixture.repoPath)).toBe("");
  });

  test("a second pass is current and spawns nothing", async () => {
    const fixture = await makeFixture();
    await projectSession(fixture);
    const pointer = await fs.readFile(pointerPath(fixture), "utf8");

    const second = await projectSession(fixture);

    expect(outcomeOf(second.outcomes, "openspec-store-pointer").state).toBe("current");
    expect(await fs.readFile(pointerPath(fixture), "utf8")).toBe(pointer);
    expect(await fixture.calls()).toHaveLength(1);
  });

  test("an ineligible repository is skipped with a warning naming the path", async () => {
    const fixture = await makeFixture();
    await fs.mkdir(path.join(fixture.repoPath, "openspec", "changes"), { recursive: true });

    const pointer = outcomeOf((await projectSession(fixture)).outcomes, "openspec-store-pointer");

    expect(pointer.state).toBe("skipped");
    expect(pointer.warnings?.join("\n")).toContain(
      path.join(fixture.repoPath, "openspec", "changes"),
    );
    expect(await fixture.calls()).toEqual([]);
  });

  test("an id registered elsewhere fails the entry without failing the projection", async () => {
    const fixture = await makeFixture();
    await writeOpenSpecRegistry(fixture.dataHome, { "acme-companion": "/somewhere/else" });

    const pointer = outcomeOf((await projectSession(fixture)).outcomes, "openspec-store-pointer");

    expect(pointer).toMatchObject({ state: "failed", degradable: true });
    expect(pointer.error?.message).toContain("/somewhere/else");
    expect(await fs.stat(pointerPath(fixture)).catch(() => null)).toBeNull();
  });

  test("a re-including .gitignore rule keeps the pointer unwritten and the .gitignore unchanged", async () => {
    const fixture = await makeFixture();
    await fs.writeFile(path.join(fixture.repoPath, ".gitignore"), "!openspec/\n");

    const pointer = outcomeOf((await projectSession(fixture)).outcomes, "openspec-store-pointer");

    expect(pointer.state).toBe("skipped");
    expect(pointer.warnings?.join("\n")).toContain("not ignored by Git");
    expect(await fs.stat(pointerPath(fixture)).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(fixture.repoPath, ".gitignore"), "utf8")).toBe(
      "!openspec/\n",
    );
  });

  test("a companion without OpenSpec gets no pointer and no registration", async () => {
    const fixture = await makeFixture();
    await fs.rm(path.join(fixture.companionPath, "openspec"), { recursive: true });

    const pointer = outcomeOf((await projectSession(fixture)).outcomes, "openspec-store-pointer");

    expect(pointer.state).toBe("skipped");
    expect(await fixture.calls()).toEqual([]);
  });
});

describe("openspec store round trip", () => {
  test("unproject leaves the repository byte-identical and the registration in place", async () => {
    const fixture = await makeFixture();
    const before = await snapshot(fixture.repoPath);

    await projectSession(fixture);
    const removal = await unproject({ repoPath: fixture.repoPath });

    expect(await snapshot(fixture.repoPath)).toEqual(before);
    expect(outcomeOf(removal.outcomes, "openspec-store-pointer")).toMatchObject({
      state: "removed",
      retains: "openspec-store-registration",
    });
    expect(await checkStoreRegistration(fixture.companionPath, "acme-companion")).toEqual({
      state: "registered",
    });
  });

  test("cleanup names the pointer removed and the registration retained", async () => {
    const fixture = await makeFixture();
    await writeRepoLocalRegistryEntry(
      fixture.repoPath,
      fixture.companionPath,
      fixture.repository,
      "existing",
    );
    await projectSession(fixture);

    const result = await cleanupWorkingRepository(fixture.repoPath, [fixture.companionPath]);

    expect(result.removed).toContain("openspec/config.yaml");
    expect(result.retained).toContain("openspec-store-registration");
  });

  test("a foreign config and a planning root are left untouched", async () => {
    for (const shape of ["foreign", "planning"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two independent fixtures
      const fixture = await makeFixture();
      if (shape === "foreign") {
        await fs.mkdir(path.join(fixture.repoPath, "openspec"));
        await fs.writeFile(pointerPath(fixture), "schema: spec-driven\n");
      } else {
        await fs.mkdir(path.join(fixture.repoPath, "openspec", "specs"), { recursive: true });
        await fs.writeFile(path.join(fixture.repoPath, "openspec", "specs", "x.md"), "x\n");
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const before = await snapshot(path.join(fixture.repoPath, "openspec"));

      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await projectSession(fixture);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      expect(await excludeLines(fixture)).not.toContain("/openspec/");
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await unproject({ repoPath: fixture.repoPath });
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      expect(await snapshot(path.join(fixture.repoPath, "openspec"))).toEqual(before);
    }
  });

  test("a wiped registry is registered again on the next session projection", async () => {
    const fixture = await makeFixture();
    await projectSession(fixture);
    await fs.rm(openSpecRegistryPath(fixture.dataHome));

    const pointer = outcomeOf((await projectSession(fixture)).outcomes, "openspec-store-pointer");

    expect(pointer.state).toBe("written");
    expect(await fixture.calls()).toHaveLength(2);
    expect(await checkStoreRegistration(fixture.companionPath, "acme-companion")).toEqual({
      state: "registered",
    });
  });
});
