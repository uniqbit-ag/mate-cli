import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { GlobalConfigStore } from "./global-config-store";
import { resolveRootContext } from "./root-context";

const tempRoots: string[] = [];
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalRepoId = process.env.MATE_REPO_ID;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function writeFrameworkConfig(rootPath: string, yaml: string): Promise<void> {
  const configPath = path.join(rootPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, yaml, "utf8");
}

function globalStoreIn(root: string): GlobalConfigStore {
  return new GlobalConfigStore(path.join(root, "config.yaml"));
}

beforeEach(() => {
  delete process.env.MATE_ARTIFACT_PATH;
  delete process.env.MATE_REPO_ID;
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  process.env.MATE_REPO_ID = originalRepoId;
});

test("resolves a local companion config as companion", async () => {
  const root = await makeTempDir("root-context-companion-");
  await writeFrameworkConfig(root, "allowedAgents:\n  - claude\n");

  const context = await resolveRootContext(root, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("companion");
  expect(context.origin).toBe("local");
  expect(context.rootPath).toBe(root);
  expect(context.config?.allowedAgents).toEqual(["claude"]);
});

test("maps config.type hub to kind hub", async () => {
  const root = await makeTempDir("root-context-hub-");
  await writeFrameworkConfig(
    root,
    [
      'type: "hub"',
      "hub:",
      "  companions:",
      "    - id: acme",
      "      path: members/acme",
      "      source:",
      '        kind: "local"',
      "        path: /tmp/acme",
      "allowedAgents: []",
    ].join("\n"),
  );

  const context = await resolveRootContext(root, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("hub");
  expect(context.origin).toBe("local");
  expect(context.config?.hub?.companions).toHaveLength(1);
});

test("a companion nested below a hub root resolves as companion", async () => {
  const root = await makeTempDir("root-context-hub-member-");
  await writeFrameworkConfig(root, ['type: "hub"', "hub:", "  companions: []", ""].join("\n"));
  const member = path.join(root, "companions", "app");
  await writeFrameworkConfig(member, 'type: "companion"\nallowedAgents: []\n');

  const context = await resolveRootContext(member, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("companion");
  expect(context.rootPath).toBe(member);
});

test("maps config.type working to kind working", async () => {
  const root = await makeTempDir("root-context-working-");
  await writeFrameworkConfig(root, 'type: "working"\nallowedAgents: []\n');

  const context = await resolveRootContext(root, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("working");
  expect(context.origin).toBe("local");
});

test("resolves the nearest configured ancestor from a subdirectory", async () => {
  const root = await makeTempDir("root-context-walk-");
  await writeFrameworkConfig(root, "allowedAgents: []\n");
  const nested = path.join(root, "src", "deep");
  await fs.mkdir(nested, { recursive: true });

  const context = await resolveRootContext(nested, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("companion");
  expect(context.origin).toBe("local");
  expect(context.rootPath).toBe(root);
});

test("MATE_ARTIFACT_PATH takes precedence and classifies the env root", async () => {
  const root = await makeTempDir("root-context-env-");
  const companion = path.join(root, "companion");
  await fs.mkdir(companion, { recursive: true });
  await writeFrameworkConfig(companion, "allowedAgents: []\n");
  process.env.MATE_ARTIFACT_PATH = companion;
  process.env.MATE_REPO_ID = "app";

  const context = await resolveRootContext(root, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("companion");
  expect(context.origin).toBe("env");
  expect(context.rootPath).toBe(companion);
  expect(context.repositoryId).toBe("app");
});

test("resolves a registry match as the companion root with origin registry", async () => {
  const { writeRepoLocalRegistryEntry } = await import("./repo-local-registry");
  const root = await makeTempDir("root-context-registry-");
  const working = path.join(root, "working");
  const companion = path.join(root, "companion");
  await fs.mkdir(working, { recursive: true });
  await fs.mkdir(companion, { recursive: true });
  await writeFrameworkConfig(companion, "allowedAgents: []\n");
  await writeRepoLocalRegistryEntry(working, companion, { id: "app", path: working }, "git");

  const context = await resolveRootContext(working, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("companion");
  expect(context.origin).toBe("registry");
  expect(context.rootPath).toBe(companion);
  expect(context.repositoryId).toBe("app");
  expect(context.linkedRepository?.id).toBe("app");
});

test("passes through ambiguity diagnostics from the resolver", async () => {
  const { writeRepoLocalRegistryEntry } = await import("./repo-local-registry");
  const root = await makeTempDir("root-context-ambiguous-");
  const working = path.join(root, "working");
  const companionA = path.join(root, "companion-a");
  const companionB = path.join(root, "companion-b");
  await fs.mkdir(working, { recursive: true });
  for (const companion of [companionA, companionB]) {
    await fs.mkdir(companion, { recursive: true });
    await writeFrameworkConfig(companion, "allowedAgents: []\n");
    await writeRepoLocalRegistryEntry(working, companion, { id: "app", path: working }, "git");
  }

  const context = await resolveRootContext(working, { globalConfigStore: globalStoreIn(root) });

  expect(context.origin).toBe("registry");
  expect(context.resolution.ambiguousMatches).toHaveLength(2);
});

test("resolves core when nothing is configured", async () => {
  const root = await makeTempDir("root-context-core-");

  const context = await resolveRootContext(root, { globalConfigStore: globalStoreIn(root) });

  expect(context.kind).toBe("core");
  expect(context.origin).toBe("none");
  expect(context.rootPath).toBeUndefined();
  expect(context.resolution.failures).toEqual([]);
});
