import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import {
  createOpenspecPlugin,
  deriveOpenSpecTools,
  MATE_OPENSPEC_SKILLS,
  OPENSPEC_SKILLS,
} from "./openspec";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeCtx(
  companionPath: string,
  activeProviders: string[],
  capabilities = [{ name: "openspec" }],
  mode: SetupContext["mode"] = "setup",
  git?: "auto",
): SetupContext {
  return {
    companionPath,
    activeProviders,
    mode,
    config: {
      profiles: {
        default: {
          name: "default",
          allowedAgents: activeProviders,
        },
      },
      capabilities,
      git,
    },
  };
}

const openspecAvailable = {
  isCommandOnPath: (command: string) => command === "openspec",
  getInstalledVersion: async () => undefined,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("deriveOpenSpecTools", () => {
  test("keeps only supported providers in stable runtime order", () => {
    expect(deriveOpenSpecTools(["headroom", "claude", "custom", "opencode"])).toEqual([
      "claude",
      "opencode",
    ]);
  });
});

describe("createOpenspecPlugin", () => {
  test("runs openspec init and update for active supported providers", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => undefined,
    });
    const ctx = makeCtx("/tmp/companion", ["claude", "opencode"]);

    await plugin.apply(ctx);

    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      "openspec",
      ["init", "--tools", "claude,opencode", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      "openspec",
      ["update", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
  });

  test("setup installs missing openspec with npm before reconciliation", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    let openspecAvailable = false;
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: async (...args) => {
        await installCommand(...args);
        openspecAvailable = true;
      },
      confirm,
      isCommandOnPath: (command) =>
        command === "npm" || (command === "openspec" && openspecAvailable),
    });

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(confirm).toHaveBeenCalledWith("Run this install command now?");
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
  });

  test("setup prompts and upgrades when the installed openspec is outdated", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stdoutSpy).toHaveBeenCalledWith(
        expect.stringContaining("installed version 1.2.0 is outdated (latest 1.6.0)"),
      );
    } finally {
      stdoutSpy.mockRestore();
    }

    expect(confirm).toHaveBeenCalledWith("Upgrade openspec now?");
    expect(installCommand).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@fission-ai/openspec@latest"],
      { cwd: "/tmp/companion" },
    );
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
  });

  test("setup skips the upgrade when the user declines", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => false);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("upgrade skipped"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      "openspec",
      ["init", "--tools", "claude", "--force", "/tmp/companion"],
      { cwd: "/tmp/companion" },
    );
  });

  test("sync warns without prompting when the installed openspec is outdated", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("installed version 1.2.0 is outdated (latest 1.6.0)"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("does not prompt when the installed openspec version is current", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.6.0",
      fetchLatestVersion: async () => "1.6.0",
    });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("does not prompt when the version lookup fails", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: (command) => command === "openspec",
      getInstalledVersion: async () => "1.2.0",
      fetchLatestVersion: async () => undefined,
    });

    await plugin.apply(makeCtx("/tmp/companion", ["claude"]));

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
  });

  test("setup reports manual install and skips reconciliation when npm is unavailable", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: () => false,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("setup skips reconciliation when openspec install fails", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: mock(async () => {
        throw new Error("install failed");
      }),
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "npm",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("openspec: install failed"));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("setup reports mismatch when install completes but openspec stays unavailable", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand: mock(async () => {}),
      confirm: mock(async () => true),
      isCommandOnPath: (command) => command === "npm",
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("openspec install completed but the binary is still not available"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("sync reports manual install without prompting or running openspec reconciliation", async () => {
    const runCommand = mock(async () => {});
    const installCommand = mock(async () => {});
    const confirm = mock(async () => true);
    const plugin = createOpenspecPlugin({
      runCommand,
      installCommand,
      confirm,
      isCommandOnPath: () => false,
    });

    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await plugin.apply(makeCtx("/tmp/companion", ["claude"], [{ name: "openspec" }], "sync"));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("npm install -g @fission-ai/openspec@latest"),
      );
    } finally {
      stderrSpy.mockRestore();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(installCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  test("installs mate-authored openspec skills when Git auto mode is enabled", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(
      makeCtx(root, ["claude", "opencode"], [{ name: "openspec" }], "setup", "auto"),
    );

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const skill of MATE_OPENSPEC_SKILLS) {
        await expect(
          fs.readFile(path.join(root, runtimeDir, "skills", skill, "SKILL.md"), "utf8"),
        ).resolves.toContain("mate artifact finish");
      }
    }
  });

  test("installs the Claude openspec auto-finish hook", async () => {
    const root = await makeTempDir("mate-openspec-claude-hook-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.forProvider!.claude.apply(
      makeCtx(root, ["claude"], [{ name: "openspec" }], "setup", "auto"),
    );

    await expect(
      fs.access(path.join(root, ".claude", "hooks", "mate-openspec-artifact-finish.sh")),
    ).resolves.toBeNull();
  });

  test("does not install the Claude openspec auto-finish hook when Git auto mode is off", async () => {
    const root = await makeTempDir("mate-openspec-claude-hook-off-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.forProvider!.claude.apply(makeCtx(root, ["claude"]));

    await expect(
      fs.access(path.join(root, ".claude", "hooks", "mate-openspec-artifact-finish.sh")),
    ).rejects.toThrow();
  });

  test("does not install mate-authored skills for inactive providers", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-inactive-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("capability teardown removes mate-authored openspec skills too", async () => {
    const root = await makeTempDir("mate-openspec-mate-skills-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const skill of MATE_OPENSPEC_SKILLS) {
        await fs.mkdir(path.join(root, runtimeDir, "skills", skill), { recursive: true });
        await fs.writeFile(
          path.join(root, runtimeDir, "skills", skill, "SKILL.md"),
          `${runtimeDir}\n`,
          "utf8",
        );
      }
    }

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("skips openspec CLI calls when no supported providers are active", async () => {
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx("/tmp/companion", []));

    expect(runCommand).not.toHaveBeenCalled();
  });

  test("seeds mate-v1 schema files and config when the schema profile is selected", async () => {
    const root = await makeTempDir("mate-openspec-schema-seed-");
    const runCommand = mock(async () => {});
    const plugin = createOpenspecPlugin({ runCommand, ...openspecAvailable });

    await plugin.apply(makeCtx(root, ["claude"], [{ name: "openspec", schemaProfile: "mate-v1" }]));

    await expect(fs.readFile(path.join(root, "openspec", "config.yaml"), "utf8")).resolves.toBe(
      "schema: mate-v1\n",
    );
    await expect(
      fs.access(path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml")),
    ).resolves.toBeNull();

    const schema = await fs.readFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "utf8",
    );
    expect(schema).toContain("version: 1.1");
    expect(schema).toContain("Every delta and canonical spec MUST include `area: <area>`");
    expect(schema).toContain("Every requirement MUST also include an inline `**Area:**` marker");
    expect(schema).toContain("Every change MUST name at least one Area");
    expect(schema).toContain("never use `N/A`");
  });

  test("default schema profile removes prior mate-v1 managed files", async () => {
    const root = await makeTempDir("mate-openspec-schema-default-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });
    await fs.mkdir(path.join(root, "openspec", "schemas", "mate-v1"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "name: mate-v1\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, "openspec"), { recursive: true });
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");

    await plugin.apply(makeCtx(root, ["claude"]));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).rejects.toThrow();
  });

  test("provider teardown removes only that runtime's openspec skills", async () => {
    const root = await makeTempDir("mate-openspec-provider-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}), ...openspecAvailable });

    for (const skill of OPENSPEC_SKILLS) {
      await fs.mkdir(path.join(root, ".claude", "skills", skill), { recursive: true });
      await fs.writeFile(
        path.join(root, ".claude", "skills", skill, "SKILL.md"),
        "claude\n",
        "utf8",
      );
      await fs.mkdir(path.join(root, ".opencode", "skills", skill), { recursive: true });
      await fs.writeFile(
        path.join(root, ".opencode", "skills", skill, "SKILL.md"),
        "opencode\n",
        "utf8",
      );
    }

    await plugin.forProvider!.claude.teardown(makeCtx(root, ["opencode"]));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(
      fs.access(path.join(root, ".opencode", "skills", "openspec-explore", "SKILL.md")),
    ).resolves.toBeNull();
  });

  test("capability teardown removes all managed openspec skill runtimes", async () => {
    const root = await makeTempDir("mate-openspec-full-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });

    for (const runtimeDir of [".claude", ".opencode"]) {
      for (const skill of OPENSPEC_SKILLS) {
        await fs.mkdir(path.join(root, runtimeDir, "skills", skill), { recursive: true });
        await fs.writeFile(
          path.join(root, runtimeDir, "skills", skill, "SKILL.md"),
          `${runtimeDir}\n`,
          "utf8",
        );
      }
    }

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, ".claude", "skills"))).rejects.toThrow();
    await expect(fs.access(path.join(root, ".opencode", "skills"))).rejects.toThrow();
  });

  test("capability teardown removes managed mate-v1 schema state", async () => {
    const root = await makeTempDir("mate-openspec-schema-teardown-");
    const plugin = createOpenspecPlugin({ runCommand: mock(async () => {}) });
    await fs.mkdir(path.join(root, "openspec", "schemas", "mate-v1"), { recursive: true });
    await fs.writeFile(
      path.join(root, "openspec", "schemas", "mate-v1", "schema.yaml"),
      "name: mate-v1\n",
      "utf8",
    );
    await fs.writeFile(path.join(root, "openspec", "config.yaml"), "schema: mate-v1\n", "utf8");

    await plugin.teardown(makeCtx(root, []));

    await expect(fs.access(path.join(root, "openspec", "config.yaml"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "openspec", "schemas", "mate-v1"))).rejects.toThrow();
  });
});
