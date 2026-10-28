import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import packageJson from "../../../package.json";
import { createTempDir, overrideEnv } from "../../../../../test/fixtures";
import { FRAMEWORK_NAME } from "../../framework";
import { getContextModePackageRoot } from "../../lib/context-mode-package";
import { ConfigStore } from "../../lib/orchestrator/config-store";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repository-link";
import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { getClaudePluginRoot, MATE_CLAUDE_PLUGIN_NAME } from "../../lib/package-paths";
import type {
  CapabilityPlugin,
  PluginRegistration,
  RuntimeContributionsByRuntime,
} from "../../tools/setup/plugin";
import { inspectClaudePluginDirectories } from "../../tools/setup";
import { createClaudePlugin } from "../../tools/setup/providers/claude";
import { runDoctorCommand, type DoctorReport } from "./doctor";

const tempRoots: string[] = [];
let restoreEnvironment: () => void;

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  tempRoots.push(dir);
  return dir;
}

/** `--json` goes through `writeJsonStdout`, the rendered report through `console.log`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    chunks.push(args.length > 0 ? args.join(" ") : "");
  });
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(String(chunk).replace(/\n$/, ""));
    const callback = rest.find((argument) => typeof argument === "function");
    if (callback) (callback as (error?: Error | null) => void)(null);
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
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
  restoreEnvironment = overrideEnv({ MATE_ARTIFACT_PATH: undefined, MATE_REPO_ID: undefined });
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  restoreEnvironment();
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
    const companionPath = await setupCompanion(root, repoPath, {
      allowedAgents: ["claude"],
      packageManagers: ["uv"],
      capabilities: [{ name: "openspec" }],
    });
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand([], { cwd: repoPath, globalConfigStore, pathValue: binPath }),
    );

    expect(output).toContain("Tool Installations");
    expect(output).toContain("uv");
    expect(output).toContain("openspec");
    expect(output).not.toContain("rtk");
    expect(output).toContain("ok");
    expect(output).toContain("missing");
    expect(output).not.toContain("tokensave");
    expect(output).not.toContain("graphify");
  });

  test("checks RTK when it is the only selected capability", async () => {
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
    expect(output).not.toContain("openspec");
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

  test("names declared plugins that fail verification and exits non-zero", async () => {
    const root = await makeTempDir("doctor-plugins-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(localConfigPath, "allowedAgents:\n  - claude\n", "utf8");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    const verified: string[] = [];
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const originalExitCode = process.exitCode;

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], {
          cwd: root,
          globalConfigStore,
          inspectPlugins: async (companionPath) => {
            verified.push(companionPath);
            return {
              failures: [{ package: "@acme/reader", reason: "not installed" }],
              capabilities: [],
            };
          },
        }),
      );

      expect(verified).toEqual([root]);
      expect(output).toContain("Declared Plugins");
      expect(output).toContain("@acme/reader");
      expect(stderr.join("")).toContain(`${FRAMEWORK_NAME}: plugin @acme/reader: not installed`);
      expect(process.exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("omits the declared plugins section and keeps a zero exit when plugins verify", async () => {
    const root = await makeTempDir("doctor-plugins-ok-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await fs.writeFile(localConfigPath, "allowedAgents:\n  - claude\n", "utf8");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], {
          cwd: root,
          globalConfigStore,
          inspectPlugins: async () => ({ failures: [], capabilities: [] }),
        }),
      );

      expect(output).not.toContain("Declared Plugins");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = originalExitCode ?? 0;
    }
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

describe("doctor audiences", () => {
  const config: FrameworkConfig = {
    allowedAgents: ["claude"],
    packageManagers: [],
    capabilities: [],
    audiences: {
      ba: { plugins: [{ package: "@acme/analyst", version: "1.0.0" }] },
      qa: { studio: { terminal: { agent: "tester" } } },
    },
  };

  async function run(env: Record<string, string | undefined>, argv: string[] = ["--json"]) {
    const root = await makeTempDir("doctor-audiences-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath, config);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);
    process.exitCode = 0;
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const output = await captureStdout(() =>
        runDoctorCommand(argv, { cwd: repoPath, globalConfigStore, env }),
      );
      return {
        output,
        exitCode: process.exitCode,
        stderr: stderr.mock.calls.map((c) => String(c[0])).join(""),
      };
    } finally {
      stderr.mockRestore();
      process.exitCode = 0;
    }
  }

  test("JSON names the active and declared audiences", async () => {
    const { output } = await run({ MATE_AUDIENCE: "ba" });
    expect(JSON.parse(output).audiences).toEqual({ declared: ["ba", "qa"], active: "ba" });
  });

  test("JSON reports no active audience when none is selected", async () => {
    const { output, exitCode } = await run({});
    expect(JSON.parse(output).audiences).toEqual({ declared: ["ba", "qa"], active: null });
    expect(exitCode).not.toBe(1);
  });

  test("an unknown audience is an error naming it and exits non-zero", async () => {
    const { output, exitCode, stderr } = await run({ MATE_AUDIENCE: "dev" });
    expect(JSON.parse(output).audiences).toEqual({ declared: ["ba", "qa"], active: null });
    expect(stderr).toContain('"dev"');
    expect(stderr).toContain("ba, qa");
    expect(exitCode).toBe(1);
  });

  test("plugin checks cover the effective set only", async () => {
    const inactive = JSON.parse((await run({})).output);
    expect(inactive.pluginFailures).toEqual([]);
    const active = JSON.parse((await run({ MATE_AUDIENCE: "ba" })).output);
    expect(active.pluginFailures.map((f: { package: string }) => f.package)).toEqual([
      "@acme/analyst",
    ]);
  });

  test("the text report lists declared and active audiences", async () => {
    const { output } = await run({ MATE_AUDIENCE: "ba" }, []);
    expect(output).toContain("Audiences");
    expect(output).toContain("ba, qa");
  });

  test("a companion without audiences reports none and is unchanged", async () => {
    const root = await makeTempDir("doctor-no-audiences-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], { cwd: repoPath, globalConfigStore, env: {} }),
    );

    expect(JSON.parse(output).audiences).toBeUndefined();
  });
});
describe("doctor OpenSpec rules keys", () => {
  async function companionWithConfig(
    openspecConfig: string | null,
    capabilities: FrameworkConfig["capabilities"] = [{ name: "openspec" }],
  ): Promise<{ root: string; globalConfigStore: GlobalConfigStore }> {
    const root = await makeTempDir("doctor-openspec-rules-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await new ConfigStore(localConfigPath).save({ allowedAgents: ["claude"], capabilities });
    const schemaDir = path.join(root, "openspec", "schemas", "acme-flow");
    await fs.mkdir(schemaDir, { recursive: true });
    await fs.writeFile(
      path.join(schemaDir, "schema.yaml"),
      "name: acme-flow\nartifacts:\n  - id: brief\n  - id: tasks\n",
      "utf8",
    );
    if (openspecConfig !== null) {
      await fs.writeFile(path.join(root, "openspec", "config.yaml"), openspecConfig, "utf8");
    }
    return { root, globalConfigStore: new GlobalConfigStore(path.join(root, "config.yaml")) };
  }

  async function doctorJson(root: string, globalConfigStore: GlobalConfigStore) {
    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], {
        cwd: root,
        globalConfigStore,
        inspectPlugins: async () => ({ failures: [], capabilities: [] }),
      }),
    );
    return JSON.parse(output) as {
      openspecRuleWarnings?: Array<{ key: string; message: string }>;
    };
  }

  test("warns about an unknown rules key with a pointer and keeps the exit code", async () => {
    const { root, globalConfigStore } = await companionWithConfig(
      "schema: acme-flow\nrules:\n  proposal: [a]\n  implementation: [b]\n",
    );
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], {
          cwd: root,
          globalConfigStore,
          inspectPlugins: async () => ({ failures: [], capabilities: [] }),
        }),
      );

      expect(output).toContain("OpenSpec Config");
      expect(output).toContain("implementation");
      expect(output).toContain("operations.apply.guidance");
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("JSON carries the warning naming the key", async () => {
    const { root, globalConfigStore } = await companionWithConfig(
      "rules:\n  implementation: [b]\n",
    );

    const report = await doctorJson(root, globalConfigStore);

    expect(report.openspecRuleWarnings).toEqual([
      {
        key: "implementation",
        message: expect.stringContaining("operations.archive.guidance"),
      },
    ]);
  });

  test("built-in and companion schema artifact IDs are known", async () => {
    const { root, globalConfigStore } = await companionWithConfig(
      "rules:\n  proposal: [a]\n  specs: [b]\n  design: [c]\n  tasks: [d]\n  brief: [e]\n",
    );

    expect((await doctorJson(root, globalConfigStore)).openspecRuleWarnings).toBeUndefined();
  });

  test("a missing or unparseable config is silent", async () => {
    for (const config of [null, "rules: [\n"]) {
      const { root, globalConfigStore } = await companionWithConfig(config);

      expect((await doctorJson(root, globalConfigStore)).openspecRuleWarnings).toBeUndefined();
    }
  });

  test("the check is inactive without the openspec capability", async () => {
    const { root, globalConfigStore } = await companionWithConfig(
      "rules:\n  implementation: [b]\n",
      [],
    );

    expect((await doctorJson(root, globalConfigStore)).openspecRuleWarnings).toBeUndefined();
  });
});

describe("doctor companion CLAUDE.md text", () => {
  async function companionWithClaudeMd(
    claudeMd: string | null,
  ): Promise<{ root: string; globalConfigStore: GlobalConfigStore }> {
    const root = await makeTempDir("doctor-claude-md-");
    const localConfigPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(localConfigPath), { recursive: true });
    await new ConfigStore(localConfigPath).save({ allowedAgents: ["claude"], capabilities: [] });
    if (claudeMd !== null) await fs.writeFile(path.join(root, "CLAUDE.md"), claudeMd, "utf8");
    return { root, globalConfigStore: new GlobalConfigStore(path.join(root, "config.yaml")) };
  }

  const options = (root: string, globalConfigStore: GlobalConfigStore) => ({
    cwd: root,
    globalConfigStore,
    inspectPlugins: async () => ({ failures: [], capabilities: [] }),
  });

  async function doctorJson(root: string, globalConfigStore: GlobalConfigStore) {
    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], options(root, globalConfigStore)),
    );
    return JSON.parse(output) as {
      companionInstructionWarnings?: Array<{ file: string; message: string }>;
    };
  }

  const MANAGED = [
    "<!-- mate:managed:context-mode:abc123 start -->",
    "## Context Mode",
    "",
    "Use it.",
    "<!-- mate:managed:context-mode:abc123 end -->",
  ].join("\n");

  test("warns about a user-written section, naming the file, and keeps the exit code", async () => {
    const { root, globalConfigStore } = await companionWithClaudeMd(
      `@AGENTS.md\n\n${MANAGED}\n\n## Team notes\n\nAlways rebase.\n`,
    );
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const output = await captureStdout(() =>
        runDoctorCommand([], options(root, globalConfigStore)),
      );

      expect(output).toContain("Companion Instructions");
      expect(output).toContain(path.join(root, "CLAUDE.md"));
      expect(output).toContain("does not reach Working Repository sessions");
      expect(output).toContain(path.join(root, "AGENTS.md"));
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("JSON carries the same warning", async () => {
    const { root, globalConfigStore } = await companionWithClaudeMd(
      "@AGENTS.md\n\nAlways rebase.\n",
    );

    expect((await doctorJson(root, globalConfigStore)).companionInstructionWarnings).toEqual([
      {
        file: path.join(root, "CLAUDE.md"),
        message: expect.stringContaining("does not reach Working Repository sessions"),
      },
    ]);
  });

  test("a Working Repository is checked against its resolved companion, not its own CLAUDE.md", async () => {
    const root = await makeTempDir("doctor-claude-md-working-");
    const repoPath = path.join(root, "working");
    await fs.mkdir(repoPath, { recursive: true });
    const companionPath = await setupCompanion(root, repoPath);
    await fs.writeFile(path.join(repoPath, "CLAUDE.md"), "Repository notes.\n", "utf8");
    await fs.writeFile(path.join(companionPath, "CLAUDE.md"), "@AGENTS.md\n\nAlways rebase.\n");
    const globalConfigStore = new GlobalConfigStore(path.join(root, "config.yaml"));
    await globalConfigStore.register(companionPath);

    const output = await captureStdout(() =>
      runDoctorCommand(["--json"], { ...options(repoPath, globalConfigStore), env: {} }),
    );

    expect(JSON.parse(output).companionInstructionWarnings).toEqual([
      {
        file: path.join(companionPath, "CLAUDE.md"),
        message: expect.stringContaining("does not reach Working Repository sessions"),
      },
    ]);
  });

  test("a template-shaped CLAUDE.md, or none, is quiet", async () => {
    for (const claudeMd of [null, "@AGENTS.md\n", `@AGENTS.md\n\n${MANAGED}\n<!-- a note -->\n`]) {
      const { root, globalConfigStore } = await companionWithClaudeMd(claudeMd);

      expect(
        (await doctorJson(root, globalConfigStore)).companionInstructionWarnings,
      ).toBeUndefined();
    }
  });
});

describe("contributed Claude plugins", () => {
  /**
   * A companion with `capabilities` enabled for Claude; context-mode's folder
   * holds a manifest when `installed`, and `marketplace` as its marketplace file.
   */
  async function companion(capabilities: string[], installed = false, marketplace?: string) {
    const root = await makeTempDir("doctor-claude-plugins-");
    const configPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await new ConfigStore(configPath).save({
      allowedAgents: ["claude"],
      capabilities: capabilities.map((name) => ({ name })),
    });
    const folder = getContextModePackageRoot(root);
    if (installed) {
      await fs.mkdir(path.join(folder, ".claude-plugin"), { recursive: true });
      await fs.writeFile(
        path.join(folder, ".claude-plugin", "plugin.json"),
        `{"name":"context-mode"}\n`,
      );
      if (marketplace !== undefined) {
        await fs.writeFile(path.join(folder, ".claude-plugin", "marketplace.json"), marketplace);
      }
    }
    const deps = {
      cwd: root,
      globalConfigStore: new GlobalConfigStore(path.join(root, "config.yaml")),
      inspectPlugins: async () => ({ failures: [], capabilities: [] }),
    };
    return { folder, deps };
  }

  const SHIPPED_MARKETPLACE = `${JSON.stringify({
    name: "context-mode",
    owner: { name: "Mert Koseoğlu" },
    plugins: [{ name: "context-mode", source: "./" }],
  })}\n`;
  const FOREIGN_MARKETPLACE = `{"name":"tools","owner":{"name":"Acme"},"plugins":[]}\n`;

  test("lists an installed context-mode plugin as present, with the marketplace plain sessions use", async () => {
    const { folder, deps } = await companion(["context-mode"], true, SHIPPED_MARKETPLACE);

    const output = await captureStdout(() => runDoctorCommand([], deps));

    expect(output).toContain("Claude Plugins");
    expect(output).toMatch(
      new RegExp(`\\| context-mode +\\| ${folder} +\\| present +\\| marketplace context-mode +\\|`),
    );
    expect(output).toContain("only in a wrapped repository that Claude Code trusts");
    expect(output).not.toContain("load only in sessions started with");
  });

  test("names why plain sessions do not load a folder with a foreign marketplace", async () => {
    const { folder, deps } = await companion(["context-mode"], true, FOREIGN_MARKETPLACE);

    const output = await captureStdout(() => runDoctorCommand([], deps));
    const report = JSON.parse(await captureStdout(() => runDoctorCommand(["--json"], deps))) as {
      claudePlugins?: unknown;
    };

    expect(output).toMatch(
      new RegExp(
        `\\| context-mode +\\| ${folder} +\\| present +\\| no: \\.claude-plugin/marketplace\\.json is not Mate's`,
      ),
    );
    expect(report.claudePlugins).toEqual([
      {
        capability: "context-mode",
        path: folder,
        loadable: true,
        unpublishedReason: "foreign-marketplace",
      },
    ]);
  });

  test("marks a folder without a plugin manifest as missing one", async () => {
    const { folder, deps } = await companion(["context-mode"]);

    const output = await captureStdout(() => runDoctorCommand([], deps));

    expect(output).toMatch(
      new RegExp(
        `\\| context-mode +\\| ${folder} +\\| missing \\.claude-plugin/plugin\\.json +\\|`,
      ),
    );
  });

  test("prints no section when no enabled Capability ships a Claude plugin", async () => {
    const { deps } = await companion(["openspec"]);

    const output = await captureStdout(() => runDoctorCommand([], deps));

    expect(output).not.toContain("Claude Plugins");
  });

  test("JSON carries the Capability, its folder, whether it holds a manifest and its marketplace", async () => {
    const { folder, deps } = await companion(["context-mode"], true, SHIPPED_MARKETPLACE);

    const report = JSON.parse(await captureStdout(() => runDoctorCommand(["--json"], deps))) as {
      claudePlugins?: unknown;
    };

    expect(report.claudePlugins).toEqual([
      { capability: "context-mode", path: folder, loadable: true, marketplace: "context-mode" },
    ]);
  });

  test("doctor writes no marketplace file", async () => {
    const { folder, deps } = await companion(["context-mode"], true);

    const report = JSON.parse(await captureStdout(() => runDoctorCommand(["--json"], deps))) as {
      claudePlugins?: unknown;
    };

    expect(report.claudePlugins).toEqual([
      {
        capability: "context-mode",
        path: folder,
        loadable: true,
        marketplace: "mate-plugin-context-mode",
      },
    ]);
    expect(
      await fs.stat(path.join(folder, ".claude-plugin", "marketplace.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("JSON carries no entry when no enabled Capability ships a Claude plugin", async () => {
    const { deps } = await companion([]);

    const report = JSON.parse(await captureStdout(() => runDoctorCommand(["--json"], deps))) as {
      claudePlugins?: unknown;
    };

    expect(report.claudePlugins).toBeUndefined();
  });
});

describe("Claude plugins of a distribution's Capabilities", () => {
  function capability(
    id: string,
    getRuntimeContributions: () => Promise<RuntimeContributionsByRuntime>,
    isEnabled: () => boolean = () => true,
  ): CapabilityPlugin {
    return {
      id,
      kind: "capability",
      label: id,
      description: "",
      defaultSelected: false,
      isEnabled,
      async apply() {},
      async teardown() {},
      getRuntimeContributions,
    };
  }

  const folderOf = (folder: string) => async () => ({
    claude: { pluginDirectories: [{ path: folder }] },
  });

  /** Runs doctor in a Claude companion whose registrations are `registrations` beside the Claude provider. */
  async function doctorWith(argv: string[], registrations: PluginRegistration[]) {
    const root = await makeTempDir("doctor-claude-capabilities-");
    const configPath = path.join(root, `.${FRAMEWORK_NAME}`, "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await new ConfigStore(configPath).save({ allowedAgents: ["claude"] });
    const verified: string[] = [];
    const stderr: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const originalExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const output = await captureStdout(() =>
        runDoctorCommand(argv, {
          cwd: root,
          globalConfigStore: new GlobalConfigStore(path.join(root, "config.yaml")),
          inspectPlugins: async (companionPath) => {
            verified.push(companionPath);
            return { failures: [], capabilities: [] };
          },
          hydratePlugins: async () => {},
          inspectClaudePlugins: (companionPath, config) =>
            inspectClaudePluginDirectories(companionPath, config, [
              createClaudePlugin(),
              ...registrations,
            ]),
        }),
      );
      return { output, verified, stderr: stderr.join(""), exitCode: process.exitCode };
    } finally {
      stderrSpy.mockRestore();
      process.exitCode = originalExitCode ?? 0;
    }
  }

  const healthyAndBroken = [
    capability("healthy", folderOf("/healthy-plugin")),
    capability("broken", async () => {
      throw new Error("no state file");
    }),
  ];

  test("JSON names a Capability whose contributions fail, keeps healthy rows and still verifies plugins", async () => {
    const { output, verified, stderr, exitCode } = await doctorWith(["--json"], healthyAndBroken);
    const report = JSON.parse(output) as DoctorReport;

    expect(report.claudePlugins).toEqual([
      {
        capability: "healthy",
        path: "/healthy-plugin",
        loadable: false,
        problem: "missing-manifest",
      },
    ]);
    expect(report.claudePluginFailures).toEqual([
      { capability: "broken", reason: "no state file" },
    ]);
    expect(verified).toHaveLength(1);
    expect(stderr).toContain(`${FRAMEWORK_NAME}: capability broken: no state file`);
    expect(exitCode).toBe(1);
  });

  test("names a Capability whose contributions fail in the Claude Plugins section", async () => {
    const { output } = await doctorWith([], healthyAndBroken);

    expect(output).toMatch(/\| healthy +\| \/healthy-plugin +\|/);
    expect(output).toMatch(/\| broken +\| no state file +\|/);
  });

  test("lists a required Capability's folder when the saved config leaves the Capability out", async () => {
    const required = capability("acme-required", folderOf("/acme-plugin"), () => false);

    const { output } = await doctorWith(["--json"], [{ plugin: required, policy: "required" }]);

    expect((JSON.parse(output) as DoctorReport).claudePlugins).toEqual([
      {
        capability: "acme-required",
        path: "/acme-plugin",
        loadable: false,
        problem: "missing-manifest",
      },
    ]);
  });

  test("names a relative folder as not absolute, even when it holds a manifest", async () => {
    const root = await makeTempDir("doctor-relative-plugin-");
    await fs.mkdir(path.join(root, "acme-plugin", ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(root, "acme-plugin", ".claude-plugin", "plugin.json"), "{}\n");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const relative = [capability("acme", folderOf("acme-plugin"))];
      const json = await doctorWith(["--json"], relative);
      const text = await doctorWith([], relative);

      expect((JSON.parse(json.output) as DoctorReport).claudePlugins).toEqual([
        { capability: "acme", path: "acme-plugin", loadable: false, problem: "not-absolute" },
      ]);
      expect(text.output).toMatch(/\| acme +\| acme-plugin +\| not an absolute path +\|/);
    } finally {
      process.chdir(cwd);
    }
  });

  test("names Mate's bundled plugin and a folder using Mate's plugin name as left out", async () => {
    const root = await makeTempDir("doctor-mate-named-plugin-");
    const impostor = path.join(root, "impostor");
    await fs.mkdir(path.join(impostor, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(impostor, ".claude-plugin", "plugin.json"),
      `{"name":"${MATE_CLAUDE_PLUGIN_NAME}"}\n`,
    );
    const bundled = getClaudePluginRoot();
    const declared = [
      capability("acme", folderOf(bundled)),
      capability("beta", folderOf(impostor)),
    ];

    const json = await doctorWith(["--json"], declared);
    const text = await doctorWith([], declared);

    expect((JSON.parse(json.output) as DoctorReport).claudePlugins).toEqual([
      { capability: "acme", path: bundled, loadable: false, problem: "bundled-mate-plugin" },
      { capability: "beta", path: impostor, loadable: false, problem: "mate-plugin-name" },
    ]);
    expect(text.output).toMatch(
      new RegExp(`\\| acme +\\| ${bundled} +\\| Mate's bundled plugin, already loaded +\\|`),
    );
    expect(text.output).toMatch(
      new RegExp(
        `\\| beta +\\| ${impostor} +\\| uses Mate's plugin name ${MATE_CLAUDE_PLUGIN_NAME} +\\|`,
      ),
    );
    expect(json.exitCode).toBe(0);
  });
});
