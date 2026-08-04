import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import packageJson from "../../../package.json";
import { FRAMEWORK_NAME } from "../../framework";
import { ConfigStore, RTK_CAPABILITY_SPLIT_MIGRATION } from "../../lib/orchestrator/config-store";
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
    allowedAgents: ["claude"],
    packageManagers: ["bun", "uv"],
    capabilities: [{ name: "openspec" }],
  },
): Promise<string> {
  const companionPath = path.join(root, "companion");
  await fs.mkdir(companionPath, { recursive: true });

  const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
  const configStore = new ConfigStore(path.join(configDir, "framework.yaml"));
  await configStore.save(config);
  await writeRepoLocalRegistryEntry(repoPath, companionPath, { id: "app", path: repoPath }, "git");

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

    expect(output).toMatch(/\| State {2,}\| working +\|/);
    expect(output).toContain(companionPath);
    expect(output).toContain("app");
    expect(output).toContain("Allowed Agents");
    expect(output).toContain("claude");
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
      allowedAgents: ["claude"],
      packageManagers: ["uv"],
      capabilities: [{ name: "openspec" }, { name: "headroom" }],
      migrations: [RTK_CAPABILITY_SPLIT_MIGRATION],
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
    expect(output).not.toContain("rtk");
    expect(output).toContain("ok");
    expect(output).toContain("missing");
    expect(output).not.toContain("tokensave");
    expect(output).not.toContain("graphify");
  });

  test("checks RTK independently without reporting Headroom", async () => {
    const root = await makeTempDir("doctor-rtk-only-");
    const repoPath = path.join(root, "working");
    const binPath = path.join(root, "bin");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(binPath, { recursive: true });
    await makeExecutable(binPath, "rtk");
    const companionPath = await setupCompanion(root, repoPath, {
      allowedAgents: ["claude"],
      packageManagers: [],
      capabilities: [{ name: "rtk" }],
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore, pathValue: binPath }),
    );

    expect(output).toContain("rtk");
    expect(output).not.toContain("headroom");
  });

  test("reports companion repository state for a local companion config", async () => {
    const root = await makeTempDir("doctor-companion-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(localConfigPath, "allowedAgents:\n  - claude\n", "utf8");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore }),
    );

    expect(output).toMatch(/\| State {2,}\| companion +\|/);
    expect(output).toContain(root);
    expect(output).toContain("Repository ID");
    expect(output).toContain("none");
  });

  test("reports required-plugin drift when a required capability is missing from the config", async () => {
    const { createMate } = await import("../../create-mate");
    const { resetActiveDistribution } = await import("../../distribution");
    const root = await makeTempDir("doctor-required-drift-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: openspec\n",
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    createMate({
      config: {
        runtime: "bun",
        version: "1.0.0",
      },
      plugins: [
        {
          plugin: {
            id: "acme-mcp",
            kind: "capability",
            label: "Acme MCP",
            description: "",
            defaultSelected: false,
            isEnabled: () => false,
            async apply() {},
            async teardown() {},
          },
          policy: "required",
        },
      ],
    });

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], { cwd: root, globalConfigStore }),
      );
      expect(output).toContain("Required Plugin Drift");
      expect(output).toContain("acme-mcp");
    } finally {
      resetActiveDistribution();
    }
  });

  test("emits no required-plugin drift when required plugins are present", async () => {
    const { createMate } = await import("../../create-mate");
    const { resetActiveDistribution } = await import("../../distribution");
    const root = await makeTempDir("doctor-required-healthy-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: acme-mcp\n",
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    createMate({
      config: {
        runtime: "bun",
        version: "1.0.0",
      },
      plugins: [
        {
          plugin: {
            id: "acme-mcp",
            kind: "capability",
            label: "Acme MCP",
            description: "",
            defaultSelected: false,
            isEnabled: (config) => (config.capabilities ?? []).some((c) => c.name === "acme-mcp"),
            async apply() {},
            async teardown() {},
          },
          policy: "required",
        },
      ],
    });

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], { cwd: root, globalConfigStore }),
      );
      expect(output).not.toContain("Required Plugin Drift");
    } finally {
      resetActiveDistribution();
    }
  });

  test("reports core state without throwing", async () => {
    const root = await makeTempDir("doctor-unlinked-");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore }),
    );

    expect(output).toMatch(/\| State {2,}\| core +\|/);
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

    expect(output).toMatch(/\| State {2,}\| working +\|/);
    expect(output).toContain(companionPath);
    expect(output).toContain("Resolution Failures");
    expect(output).toContain("No companion resolution failures encountered.");
  });

  test("reports hub kind with member health and omits working-repo sections", async () => {
    const root = await makeTempDir("doctor-hub-");
    const memberPath = path.join(root, "members", "acme");
    await fs.mkdir(memberPath, { recursive: true });
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      [
        'type: "hub"',
        "hub:",
        "  companions:",
        "    - id: acme",
        "      path: members/acme",
        "      source:",
        '        kind: "git"',
        "        url: git@acme.test:acme/companion.git",
        "      materializedCommit: aaaa1111",
        "    - id: ghost",
        "      path: members/ghost",
        "      source:",
        '        kind: "local"',
        "        path: /tmp/ghost",
        "allowedAgents:",
        "  - claude",
        "",
      ].join("\n"),
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore, gitHead: () => "aaaa1111" }),
    );

    expect(output).toMatch(/\| State {2,}\| hub +\|/);
    expect(output).toContain("Hub Members");
    expect(output).toContain("acme");
    expect(output).toContain("ok");
    expect(output).toContain("ghost");
    expect(output).toContain("missing");
    expect(output).not.toContain("Policy");
    expect(output).not.toContain("Tool Installations");
  });

  test("marks a hub member drifted when its HEAD differs from materializedCommit", async () => {
    const root = await makeTempDir("doctor-hub-drift-");
    const memberPath = path.join(root, "members", "acme");
    await fs.mkdir(memberPath, { recursive: true });
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      [
        'type: "hub"',
        "hub:",
        "  companions:",
        "    - id: acme",
        "      path: members/acme",
        "      source:",
        '        kind: "git"',
        "        url: git@acme.test:acme/companion.git",
        "      materializedCommit: aaaa1111",
        "allowedAgents:",
        "  - claude",
        "",
      ].join("\n"),
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: root, globalConfigStore, gitHead: () => "bbbb2222" }),
    );

    expect(output).toContain("drifted");
    expect(output).not.toContain("Policy");
  });

  test("resolves the companion root from a subdirectory", async () => {
    const root = await makeTempDir("doctor-subdir-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(localConfigPath, "allowedAgents:\n  - claude\n", "utf8");
    const nested = path.join(root, "src", "deep");
    await fs.mkdir(nested, { recursive: true });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: nested, globalConfigStore }),
    );

    expect(output).toMatch(/\| State {2,}\| companion +\|/);
    expect(output).toContain(root);
  });

  test("emits a machine-readable JSON report with --json for a linked working repository", async () => {
    const root = await makeTempDir("doctor-json-working-");
    const repoPath = path.join(root, "repo");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], { cwd: repoPath, globalConfigStore }),
    );

    const report = JSON.parse(output) as {
      kind: string;
      companionPath: string;
      repositoryId: string;
      policy: { allowedAgents: string[] };
      capabilities: string[];
      resolutionFailures: unknown[];
    };
    expect(output).not.toContain("Mate Doctor");
    expect(report.kind).toBe("working");
    expect(report.companionPath).toBe(companionPath);
    expect(report.repositoryId).toBe("app");
    expect(report.policy.allowedAgents).toEqual(["claude"]);
    expect(report.capabilities).toEqual(["openspec"]);
    expect(report.resolutionFailures).toEqual([]);
  });

  test("emits hub members in the JSON report", async () => {
    const root = await makeTempDir("doctor-json-hub-");
    const memberPath = path.join(root, "members", "acme");
    await fs.mkdir(memberPath, { recursive: true });
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(
      localConfigPath,
      [
        'type: "hub"',
        "hub:",
        "  companions:",
        "    - id: acme",
        "      path: members/acme",
        "      source:",
        '        kind: "git"',
        "        url: git@acme.test:acme/companion.git",
        "      materializedCommit: aaaa1111",
        "allowedAgents:",
        "  - claude",
        "",
      ].join("\n"),
      "utf8",
    );
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));

    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], { cwd: root, globalConfigStore, gitHead: () => "bbbb2222" }),
    );

    const report = JSON.parse(output) as {
      kind: string;
      hub: { members: Array<{ id: string; exists: boolean; commitStatus: string }> };
    };
    expect(report.kind).toBe("hub");
    expect(report.hub.members).toHaveLength(1);
    expect(report.hub.members[0]).toMatchObject({
      id: "acme",
      exists: true,
      commitStatus: "drifted",
    });
  });

  test("reports engines.mate as satisfied when the running version matches the declared range", async () => {
    const root = await makeTempDir("doctor-engines-ok-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath, {
      allowedAgents: ["claude"],
      packageManagers: [],
      capabilities: [],
      engines: { mate: ">=0.0.0" },
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).toContain("Version Requirement");
    expect(output).toContain("engines.mate: satisfied");
    expect(output).toContain(">=0.0.0");
    expect(output).toContain(packageJson.version);
  });

  test("reports engines.mate as unsatisfied when the running version misses the declared range", async () => {
    const root = await makeTempDir("doctor-engines-unsatisfied-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath, {
      allowedAgents: ["claude"],
      packageManagers: [],
      capabilities: [],
      engines: { mate: ">=99.0.0" },
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).toContain("Version Requirement");
    expect(output).toContain(">=99.0.0");
    expect(output).toContain(packageJson.version);
    expect(output).not.toContain("engines.mate: satisfied");
  });

  test("reports engines.mate as an invalid range", async () => {
    const root = await makeTempDir("doctor-engines-invalid-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath, {
      allowedAgents: ["claude"],
      packageManagers: [],
      capabilities: [],
      engines: { mate: ">=0.x.y" },
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).toContain("Version Requirement");
    expect(output).toContain(">=0.x.y");
    expect(output).not.toContain("engines.mate: satisfied");
  });

  test("omits the version requirement section when engines.mate is absent", async () => {
    const root = await makeTempDir("doctor-engines-absent-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore }),
    );

    expect(output).not.toContain("Version Requirement");
    expect(output).not.toContain("engines.mate");
  });
});
