/** @test-requires sockets */

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse } from "yaml";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  installCompanion,
  linkRepository,
  readJson,
  runMate,
  setupCompanion,
  writeOpenSpecStub,
  writeUvStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: setup, link and doctor", () => {
  test("commands ignore a newer release cached for the other channel", async () => {
    const scenario = await createScenario("mate-cli-e2e-canary-cache-");

    const result = await runMate(scenario, {
      cwd: scenario.root,
      args: ["doctor"],
    });

    expect(result.stderr).not.toContain("update available");
  });

  test("confirmed setup initializes only inside the temp companion and temp HOME", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-confirm-");

    const result = await setupCompanion(scenario);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Initialize this directory as a Mate companion repository?");
    await fs.access(path.join(scenario.companion, ".mate", "config", "framework.yaml"));
    await fs.access(path.join(scenario.home, ".mate", "config.yaml"));
    await expect(fs.access(path.join(scenario.working, ".mate"))).rejects.toThrow();
  });

  test("flagged setup persists only the selected providers and capabilities", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-selection-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude", "opencode"],
      capabilities: ["openspec", "rtk"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("- claude");
    expect(config).toContain("- opencode");
    expect(config).toContain("name: openspec");
    expect(config).toContain("name: rtk");
    expect(config).not.toContain("react-doctor");
  });

  test("flagged setup persists selected package managers", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-package-managers-");
    await writeUvStub(scenario);

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      packageManagers: ["bun", "uv"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("packageManagers:");
    expect(config).toContain("- bun");
    expect(config).toContain("- uv");
  });

  test("setup with the openspec capability activates mate-full", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-mate-full-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);

    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: openspec");
    expect(config).not.toContain("schemaProfile");
    const openspecConfig = parse(
      await fs.readFile(path.join(scenario.companion, "openspec", "config.yaml"), "utf8"),
    );
    expect(openspecConfig.schema).toBe("mate-full");
    expect(openspecConfig.rules.specs).toEqual([expect.stringMatching(/^\[mate\] /)]);
    await fs.access(
      path.join(scenario.companion, "openspec", "schemas", "mate-full", "schema.yaml"),
    );
    // The legacy name keeps resolving in a new companion.
    await fs.access(path.join(scenario.companion, "openspec", "schemas", "mate-v1", "schema.yaml"));
  });

  test("setup persists RTK when it is the selected capability", async () => {
    const scenario = await createScenario("mate-cli-e2e-rtk-setup-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["claude"],
      capabilities: ["rtk"],
    });

    expect(result.exitCode).toBe(0);
    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: rtk");
    expect(config).not.toContain("name: react-doctor");
  });

  test("setup writes no Mate plugin reference into the committed companion config", async () => {
    const scenario = await createScenario("mate-cli-e2e-opencode-setup-plugin-");

    const result = await setupCompanion(scenario, [], {
      allowedAgents: ["opencode"],
      capabilities: ["openspec"],
    });

    expect(result.exitCode).toBe(0);
    await fs.access(path.join(scenario.companion, "AGENTS.md"));
    const opencodeConfig = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".opencode", "opencode.json"), "utf8"),
    );
    expect(JSON.stringify(opencodeConfig)).not.toContain("mate-opencode-plugin");
    await expect(
      fs.access(path.join(scenario.companion, ".opencode", "tui.json")),
    ).rejects.toThrow();
    // Guidance is delivered through the launch environment; setup writes no
    // guidance file and copies no plugin sources.
    await expect(
      fs.access(path.join(scenario.companion, ".opencode", ".mate-guidance.json")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(scenario.companion, ".opencode", "plugins")),
    ).rejects.toThrow();
  });

  test("rerun setup removes deselected optional artifacts", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-deselect-");

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec", "react-doctor"],
        })
      ).exitCode,
    ).toBe(0);

    await fs.access(path.join(scenario.companion, ".claude", "skills", "mate-explore-change"));

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["react-doctor"],
        })
      ).exitCode,
    ).toBe(0);

    // OpenSpec is required by the CLI distribution, so its skills remain
    // installed even when it is omitted from the explicit capability flags.
    await fs.access(path.join(scenario.companion, ".claude", "skills", "mate-explore-change"));
    await fs.access(path.join(scenario.companion, "AGENTS.md"));
  });

  test("context7 registers MCP entries for both active providers and reconciles deselection", async () => {
    const scenario = await createScenario("mate-cli-e2e-context7-");
    const npmCalls = path.join(scenario.root, "npm-calls");
    const npmStub = path.join(scenario.bin, "npm");
    await fs.writeFile(
      npmStub,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmCalls)}\nexit 97\n`,
      "utf8",
    );
    await fs.chmod(npmStub, 0o755);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec", "context7"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);
    await expect(fs.access(npmCalls)).rejects.toThrow();

    const claudeMcp = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".mcp.json"), "utf8"),
    ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    expect(claudeMcp.mcpServers?.context7?.command).toBe("npx");
    expect(claudeMcp.mcpServers?.context7?.args ?? []).toEqual([
      "-y",
      "@upstash/context7-mcp@4.2.0",
    ]);

    const opencodeConfig = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".opencode", "opencode.json"), "utf8"),
    ) as { mcp?: { servers?: Record<string, { command?: string[] }> } };
    expect(opencodeConfig.mcp?.servers?.context7?.command).toEqual([
      "npx",
      "-y",
      "@upstash/context7-mcp@4.2.0",
    ]);

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["claude", "opencode"], capabilities: ["openspec", "context7"] },
          { MATE_CONTEXT7_MODE: "preinstalled" },
        )
      ).exitCode,
    ).toBe(0);

    const preinstalledClaudeMcp = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".mcp.json"), "utf8"),
    ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
    expect(preinstalledClaudeMcp.mcpServers?.context7).toEqual({
      command: "context7-mcp",
      args: [],
    });
    const preinstalledOpenCode = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".opencode", "opencode.json"), "utf8"),
    ) as { mcp?: { servers?: Record<string, { command?: string[] }> } };
    expect(preinstalledOpenCode.mcp?.servers?.context7?.command).toEqual(["context7-mcp"]);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude", "opencode"],
          capabilities: ["openspec"],
        })
      ).exitCode,
    ).toBe(0);

    const claudeMcpAfter = JSON.parse(
      await fs.readFile(path.join(scenario.companion, ".mcp.json"), "utf8").catch(() => "{}"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(claudeMcpAfter.mcpServers?.context7).toBeUndefined();

    const opencodeConfigAfter = JSON.parse(
      await fs
        .readFile(path.join(scenario.companion, ".opencode", "opencode.json"), "utf8")
        .catch(() => "{}"),
    ) as { mcp?: Record<string, unknown> };
    expect(opencodeConfigAfter.mcp?.context7).toBeUndefined();
  });

  test("setup reconciles the OpenSpec stage skills as allowed agents are added and removed", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-reconcile-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await fs.access(
      path.join(scenario.companion, ".agents", "skills", "mate-explore-change", "SKILL.md"),
    );
    await expect(
      fs.access(path.join(scenario.companion, ".agents", "skills", "openspec-explore")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, ".opencode", "skills"))).rejects.toThrow();
    await expect(
      fs.access(path.join(scenario.companion, ".opencode", "commands")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, ".claude", "skills"))).rejects.toThrow();

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["claude", "opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await fs.access(
      path.join(scenario.companion, ".claude", "skills", "mate-explore-change", "SKILL.md"),
    );
    await fs.access(
      path.join(scenario.companion, ".agents", "skills", "mate-explore-change", "SKILL.md"),
    );
    await expect(
      fs.access(path.join(scenario.companion, ".claude", "commands", "opsx")),
    ).rejects.toThrow();

    expect(
      (
        await setupCompanion(
          scenario,
          [],
          { allowedAgents: ["opencode"], capabilities: ["openspec"] },
          { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
        )
      ).exitCode,
    ).toBe(0);

    await expect(
      fs.access(path.join(scenario.companion, ".agents", "skills", "mate-explore-change")),
    ).resolves.toBeNull();

    const invocations = await readJson<Array<{ command: string; args: string[] }>>(capturePath);
    expect(invocations.map((entry) => entry.command)).toEqual(["init", "init", "init"]);
    for (const invocation of invocations) {
      expect(invocation.args.slice(0, 4)).toEqual(["init", "--tools", "none", "--force"]);
    }
  });

  test("declined setup leaves no companion config or provider files behind", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-decline-");

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["companion", "setup"],
      input: "n\n",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Aborted.");
    await expect(fs.access(path.join(scenario.companion, ".mate"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, ".claude"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.companion, "AGENTS.md"))).rejects.toThrow();
    await expect(fs.access(path.join(scenario.home, ".mate", "config.yaml"))).rejects.toThrow();
  });

  test("linking and doctor succeed in one isolated flow", async () => {
    const scenario = await createScenario("mate-cli-e2e-repo-flow-");

    expect((await setupCompanion(scenario, ["--capability", "rtk"])).exitCode).toBe(0);

    const linkResult = await linkRepository(scenario);
    expect(linkResult.exitCode).toBe(0);
    expect(linkResult.stdout).toContain("Successfully linked companion for app");

    const doctorResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["doctor"],
    });
    expect(doctorResult.exitCode).toBe(0);
    expect(doctorResult.stdout).toMatch(/\| State {2,}\| working +\|/);
    expect(doctorResult.stdout).toContain(scenario.companion);
    expect(doctorResult.stdout).toContain("app");
    expect(doctorResult.stdout).toContain("rtk");

    const jsonResult = await runMate(scenario, {
      cwd: scenario.working,
      args: ["doctor", "--json"],
    });
    expect(jsonResult.exitCode).toBe(0);
    const report = JSON.parse(jsonResult.stdout) as {
      kind: string;
      companionPath: string;
      repositoryId: string;
      policy: { allowedAgents: string[] };
    };
    expect(report.kind).toBe("working");
    expect(report.companionPath).toBe(scenario.companion);
    expect(report.repositoryId).toBe("app");
    expect(report.policy.allowedAgents.length).toBeGreaterThan(0);
  });

  test("companion list in the companion returns all linked repositories", async () => {
    const scenario = await createScenario("mate-cli-e2e-repo-list-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["companion", "list"],
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      repositories: Array<{ id: string; path: string }>;
    };
    expect(parsed.repositories).toHaveLength(1);
    expect(parsed.repositories[0].id).toBe("app");
    expect(parsed.repositories[0].path).toBe(scenario.working);
  });

  test("companion list in a working repository returns its connected companion", async () => {
    const scenario = await createScenario("mate-cli-e2e-companion-list-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "list"],
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      workingRepository: { id: string; path: string };
      companions: Array<{ path: string; repositoryId: string; active: boolean }>;
    };
    expect(parsed.workingRepository).toEqual({ id: "app", path: scenario.working });
    expect(parsed.companions).toEqual([
      { path: scenario.companion, repositoryId: "app", active: true },
    ]);
  });

  test("doctor reports companion state when no repos are linked", async () => {
    const scenario = await createScenario("mate-cli-e2e-doctor-no-repo-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["doctor"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\| State {2,}\| companion +\|/);
    expect(result.stdout).toContain("none");
    expect(result.stdout).toContain("openspec");

    const jsonResult = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["doctor", "--json"],
    });
    expect(jsonResult.exitCode).toBe(0);
    const report = JSON.parse(jsonResult.stdout) as { kind: string; companionPath: string };
    expect(report.kind).toBe("companion");
    expect(report.companionPath).toBe(scenario.companion);
  });

  test("doctor resolves the companion root from a subdirectory", async () => {
    const scenario = await createScenario("mate-cli-e2e-doctor-subdir-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    const nested = path.join(scenario.companion, "src", "deep");
    await fs.mkdir(nested, { recursive: true });

    const result = await runMate(scenario, {
      cwd: nested,
      args: ["doctor"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\| State {2,}\| companion +\|/);
    expect(result.stdout).toContain(scenario.companion);
  });

  test("doctor reports hub member health in a hub root", async () => {
    const scenario = await createScenario("mate-cli-e2e-doctor-hub-");
    const hubRoot = path.join(scenario.root, "hub");
    const membersRoot = path.join(hubRoot, "members");

    const initMember = (name: string): string => {
      const memberPath = path.join(membersRoot, name);
      spawnSync("git", ["init", "-q", memberPath], { stdio: "ignore" });
      spawnSync(
        "git",
        [
          "-C",
          memberPath,
          "-c",
          "user.email=e2e@acme.test",
          "-c",
          "user.name=e2e",
          "commit",
          "--allow-empty",
          "-q",
          "-m",
          "init",
        ],
        { stdio: "ignore" },
      );
      const head = spawnSync("git", ["-C", memberPath, "rev-parse", "HEAD"], {
        encoding: "utf8",
      });
      return head.stdout.trim();
    };

    const healthyCommit = initMember("healthy");
    initMember("drifty");
    const configPath = path.join(hubRoot, ".mate", "config", "framework.yaml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'type: "hub"',
        "hub:",
        "  companions:",
        "    - id: healthy",
        "      path: members/healthy",
        "      source:",
        '        kind: "git"',
        "        url: git@acme.test:acme/healthy.git",
        `      materializedCommit: ${healthyCommit}`,
        "    - id: drifty",
        "      path: members/drifty",
        "      source:",
        '        kind: "git"',
        "        url: git@acme.test:acme/drifty.git",
        "      materializedCommit: aaaa111122223333aaaa111122223333aaaa1111",
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

    const result = await runMate(scenario, {
      cwd: hubRoot,
      args: ["doctor"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\| State {2,}\| hub +\|/);
    expect(result.stdout).toContain("Hub Members");
    expect(result.stdout).toContain("drifted");
    expect(result.stdout).toContain("missing");
    expect(result.stdout).not.toContain("Policy");
    expect(result.stdout).not.toContain("Tool Installations");

    const jsonResult = await runMate(scenario, {
      cwd: hubRoot,
      args: ["doctor", "--json"],
    });
    expect(jsonResult.exitCode).toBe(0);
    const report = JSON.parse(jsonResult.stdout) as {
      kind: string;
      hub: { members: Array<{ id: string; commitStatus: string }> };
    };
    expect(report.kind).toBe("hub");
    expect(report.hub.members.map((member) => [member.id, member.commitStatus])).toEqual([
      ["healthy", "ok"],
      ["drifty", "drifted"],
      ["ghost", "missing"],
    ]);
  });
});
