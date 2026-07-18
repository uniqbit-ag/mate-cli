import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frameworkConfig } from "../../framework";
import { GlobalConfigStore } from "./global-config-store";
import { writeRepoLocalRegistryEntry } from "./repo-local-registry";
import { inspectSetupPreflight, looksLikeWorkingRepo } from "./setup-preflight";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function createLinkedRepoFixture() {
  const root = await makeTempDir("mate-setup-preflight-");
  const companionPath = path.join(root, "companion");
  const repositoryPath = path.join(root, "working");
  const globalConfigPath = path.join(root, "home", ".mate", "config.yaml");

  await fs.mkdir(companionPath, { recursive: true });
  await fs.mkdir(repositoryPath, { recursive: true });

  await writeRepoLocalRegistryEntry(
    repositoryPath,
    companionPath,
    { id: "app", path: repositoryPath, profile: "default" },
    "git",
  );

  const globalConfigStore = new GlobalConfigStore(globalConfigPath);
  await globalConfigStore.register(companionPath);

  return { companionPath, repositoryPath, globalConfigStore };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("inspectSetupPreflight", () => {
  test("classifies a linked working repository as a hard failure target", async () => {
    const { repositoryPath, globalConfigStore } = await createLinkedRepoFixture();

    const result = await inspectSetupPreflight(repositoryPath, globalConfigStore);

    expect(result.kind).toBe("linked-working-repo");
    if (result.kind === "linked-working-repo") {
      expect(result.match.repositoryId).toBe("app");
    }
  });

  test("prefers linked-working-repo over stray local companion config", async () => {
    const { repositoryPath, globalConfigStore } = await createLinkedRepoFixture();
    await fs.mkdir(path.join(repositoryPath, `.${frameworkConfig.name}`, "config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repositoryPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const result = await inspectSetupPreflight(repositoryPath, globalConfigStore);

    expect(result.kind).toBe("linked-working-repo");
  });

  test("prefers existing-companion over linked-working-repo when directory is a registered companion", async () => {
    const { repositoryPath, globalConfigStore } = await createLinkedRepoFixture();
    await fs.mkdir(path.join(repositoryPath, `.${frameworkConfig.name}`, "config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repositoryPath, `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );
    // Register the repository as a companion too — this is what makes it a legitimate companion
    // even though it's also inside another companion's linked working tree.
    await globalConfigStore.register(repositoryPath);

    const result = await inspectSetupPreflight(repositoryPath, globalConfigStore);

    expect(result.kind).toBe("existing-companion");
  });

  test("ignores stale working-repo registration when resolving a linked repo", async () => {
    const { repositoryPath, globalConfigStore } = await createLinkedRepoFixture();
    await globalConfigStore.register(repositoryPath);

    const result = await inspectSetupPreflight(repositoryPath, globalConfigStore);

    expect(result.kind).toBe("linked-working-repo");
  });

  test("recognizes an existing companion repository from local config", async () => {
    const root = await makeTempDir("mate-existing-companion-");
    await fs.mkdir(path.join(root, `.${frameworkConfig.name}`, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );

    const result = await inspectSetupPreflight(
      root,
      new GlobalConfigStore(path.join(root, "home", ".mate", "config.yaml")),
    );

    expect(result.kind).toBe("existing-companion");
  });
});

describe("looksLikeWorkingRepo", () => {
  test("detects strong repository markers immediately", async () => {
    const root = await makeTempDir("mate-working-repo-strong-");
    await fs.writeFile(path.join(root, "Cargo.toml"), "[package]\nname = 'app'\n", "utf8");

    await expect(looksLikeWorkingRepo(root)).resolves.toBe(true);
  });

  test("detects framework dependencies from package.json", async () => {
    const root = await makeTempDir("mate-working-repo-framework-deps-");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }, null, 2),
      "utf8",
    );

    await expect(looksLikeWorkingRepo(root)).resolves.toBe(true);
  });

  test("detects weak markers only when at least two are present", async () => {
    const root = await makeTempDir("mate-working-repo-weak-");
    await fs.writeFile(path.join(root, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(root, "Makefile"), "all:\n\t@true\n", "utf8");

    await expect(looksLikeWorkingRepo(root)).resolves.toBe(true);
  });

  test("returns false when only a single weak marker exists", async () => {
    const root = await makeTempDir("mate-working-repo-negative-");
    await fs.writeFile(path.join(root, "package.json"), "{}", "utf8");

    await expect(looksLikeWorkingRepo(root)).resolves.toBe(false);
  });
});
