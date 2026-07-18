import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { frameworkConfig } from "../../framework";
import { ConfigStore } from "../../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repo-local-registry";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { runDoctorCommand } from "./doctor";

const tempRoots: string[] = [];
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalRepoId = process.env.MATE_REPO_ID;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(args.length > 0 ? args.join(" ") : "");
  });

  try {
    await fn();
  } finally {
    logSpy.mockRestore();
  }

  return chunks.join("\n");
}

async function makeExecutable(dir: string, name: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function setupCompanion(
  root: string,
  repoPath: string,
  config: FrameworkConfig = {
    profiles: {
      default: { name: "default", allowedAgents: ["claude"] },
      strict: { name: "strict", allowedAgents: ["claude"] },
    },
    packageManagers: ["bun", "uv"],
    capabilities: [{ name: "openspec" }],
  },
): Promise<string> {
  const companionPath = path.join(root, "companion");
  await fs.mkdir(companionPath, { recursive: true });

  const configDir = path.join(companionPath, `.${frameworkConfig.name}`, "config");
  const configStore = new ConfigStore(path.join(configDir, "framework.yaml"));
  await configStore.save(config);
  await writeRepoLocalRegistryEntry(
    repoPath,
    companionPath,
    {
      id: "app",
      path: repoPath,
      profile: "strict",
      overrides: { allowedAgents: ["opencode"] },
    },
    "git",
  );

  return companionPath;
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

describe("runDoctorCommand", () => {
  test("reports linked working repository context, policy, and effective allowed agents", async () => {
    const root = await makeTempDir("doctor-linked-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).toContain("linked-working-repository");
    expect(output).toContain(companionPath);
    expect(output).toContain("app");
    expect(output).toContain("strict");
    expect(output).toContain("opencode");
    expect(output).toContain("openspec");
  });

  test("checks installations for selected package managers and capabilities only", async () => {
    const root = await makeTempDir("doctor-installations-");
    const repoPath = path.join(root, "working");
    const binPath = path.join(root, "bin");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(binPath, { recursive: true });
    await makeExecutable(binPath, "uv");
    await makeExecutable(binPath, "openspec");
    const companionPath = await setupCompanion(root, repoPath, {
      profiles: {
        default: { name: "default", allowedAgents: ["claude"] },
        strict: { name: "strict", allowedAgents: ["claude"] },
      },
      packageManagers: ["uv"],
      capabilities: [{ name: "openspec" }, { name: "headroom" }],
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore, pathValue: binPath }),
    );

    expect(output).toContain("Tool Installations");
    expect(output).toContain("uv");
    expect(output).toContain("openspec");
    expect(output).toContain("headroom");
    expect(output).toContain("rtk");
    expect(output).toContain("ok");
    expect(output).toContain("missing");
    expect(output).not.toContain("tokensave");
    expect(output).not.toContain("graphify");
  });

  test("reports companion repository state for a local companion config", async () => {
    const root = await makeTempDir("doctor-companion-");
    const localConfigPath = path.join(root, `.${frameworkConfig.name}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "profiles:\n  default:\n    name: default\n    allowedAgents:\n      - claude\n",
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore }),
    );

    expect(output).toContain("companion-repository");
    expect(output).toContain(root);
    expect(output).toContain("Repository ID");
    expect(output).toContain("none");
  });

  test("reports not-linked state without throwing", async () => {
    const root = await makeTempDir("doctor-unlinked-");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore }),
    );

    expect(output).toContain("not-linked");
    expect(output).toContain("Companion Path");
    expect(output).toContain("none");
  });

  test("does not report unrelated companion issues when resolution is repo-local", async () => {
    const root = await makeTempDir("doctor-failure-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);

    const brokenCompanionPath = path.join(root, "broken-companion");
    await fs.mkdir(brokenCompanionPath, { recursive: true });

    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(brokenCompanionPath);
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).toContain("linked-working-repository");
    expect(output).toContain(companionPath);
    expect(output).toContain("Resolution Failures");
    expect(output).toContain("No companion resolution failures encountered.");
  });
});
