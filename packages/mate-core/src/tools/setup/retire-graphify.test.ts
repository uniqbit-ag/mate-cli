import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { FrameworkConfig } from "../../lib/orchestrator/types";
import { applySetupCompatibilities } from "../setup";
import { createClaudePlugin, getCompanionClaudeSettingsPath } from "./providers/claude";
import { createOpenCodePlugin } from "./providers/opencode";
import { createGraphifyRetirementPlugin, GRAPHIFY_RETIREMENT_NOTICE } from "./retire-graphify";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function write(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/** Every file under `root` with its content, for byte-for-byte comparison. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (file.includes(`${path.sep}.git${path.sep}`)) continue;
    files[path.relative(root, file)] = await fs.readFile(file, "utf8");
  }
  return files;
}

const FRAMEWORK_YAML = `allowedAgents:
  - claude
  - opencode
capabilities:
  - name: openspec
  - name: graphify
  - name: tokensave
    settings:
      mode: acme
`;

async function makeUsedCompanion(): Promise<string> {
  const companion = await makeTempDir("mate-retire-");
  await write(path.join(companion, ".mate", "config", "framework.yaml"), FRAMEWORK_YAML);
  for (const root of [".claude", ".opencode", ".agents"]) {
    await write(path.join(companion, root, "skills", "graphify", "SKILL.md"), "# graphify\n");
  }
  await write(
    path.join(companion, "AGENTS.md"),
    "# Acme\n\nKeep this.\n\n## graphify\n\nUse graphify.\n\n## Acme notes\n\nAnd this.\n",
  );
  await write(path.join(companion, ".opencode", "plugins", "graphify.js"), "export {};\n");
  await write(
    getCompanionClaudeSettingsPath(companion),
    JSON.stringify({
      permissions: { allow: ["Skill(graphify)", "Bash(graphify:*)"] },
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "graphify hook-guard read" }] },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/acme.sh" }],
          },
        ],
      },
    }),
  );
  await write(path.join(companion, ".claude", "hooks", "acme.sh"), "#!/bin/sh\n");
  await write(path.join(companion, ".graphify", "acme", "graphify-out", "graph.json"), "{}\n");
  return companion;
}

const plugins = () => [
  createClaudePlugin(),
  createOpenCodePlugin(),
  createGraphifyRetirementPlugin(),
];

const config = (): FrameworkConfig => ({
  allowedAgents: ["claude", "opencode"],
  capabilities: [{ name: "openspec" }, { name: "graphify" }, { name: "tokensave" }],
});

async function sync(companion: string, repoPath?: string): Promise<string[]> {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await applySetupCompatibilities(companion, config(), "sync", plugins(), repoPath);
    return stderr.mock.calls.map(([chunk]) => String(chunk));
  } finally {
    stderr.mockRestore();
  }
}

describe("graphify retirement", () => {
  test("a companion that used graphify converges and keeps everything else", async () => {
    const companion = await makeUsedCompanion();
    const store = await snapshot(path.join(companion, ".graphify"));

    const output = await sync(companion);

    for (const root of [".claude", ".opencode", ".agents"]) {
      expect(await exists(path.join(companion, root, "skills", "graphify"))).toBe(false);
    }
    expect(await exists(path.join(companion, ".opencode", "plugins", "graphify.js"))).toBe(false);
    const agents = await fs.readFile(path.join(companion, "AGENTS.md"), "utf8");
    expect(agents).not.toContain("graphify");
    expect(agents).toContain("Keep this.");
    expect(agents).toContain("## Acme notes\n\nAnd this.");

    const settings = await fs.readFile(getCompanionClaudeSettingsPath(companion), "utf8");
    expect(settings).not.toContain("graphify");
    expect(settings).toContain(".claude/hooks/acme.sh");
    expect(await exists(path.join(companion, ".claude", "hooks", "acme.sh"))).toBe(true);
    expect(await snapshot(path.join(companion, ".graphify"))).toEqual(store);

    expect(await fs.readFile(path.join(companion, ".mate", "config", "framework.yaml"), "utf8"))
      .toBe(`allowedAgents:
  - claude
  - opencode
capabilities:
  - name: openspec
  - name: tokensave
    settings:
      mode: acme
`);
    expect(output.filter((line) => line.includes(GRAPHIFY_RETIREMENT_NOTICE))).toHaveLength(1);
  });

  test("a marker block without a heading goes with its content", async () => {
    const companion = await makeUsedCompanion();
    await write(
      path.join(companion, "AGENTS.md"),
      "# Acme\n\nKeep this.\n\n<!-- MATE:GRAPHIFY:START -->\nUse the code graph.\n<!-- MATE:GRAPHIFY:END -->\n\n## Acme notes\n\nAnd this.\n",
    );

    await sync(companion);

    expect(await fs.readFile(path.join(companion, "AGENTS.md"), "utf8")).toEndWith(
      "# Acme\n\nKeep this.\n\n## Acme notes\n\nAnd this.\n",
    );
  });

  test("a second run changes nothing and prints no notice", async () => {
    const companion = await makeUsedCompanion();
    await sync(companion);
    const after = await snapshot(companion);

    const output = await sync(companion);

    expect(await snapshot(companion)).toEqual(after);
    expect(output.join("")).not.toContain(GRAPHIFY_RETIREMENT_NOTICE);
  });

  test("a companion that never used graphify gets no change from the cleanup", async () => {
    const companion = await makeTempDir("mate-retire-clean-");
    const yaml = "capabilities:\n  - name: openspec\n";
    await write(path.join(companion, ".mate", "config", "framework.yaml"), yaml);
    await write(path.join(companion, "AGENTS.md"), "# Acme\n\n## Acme notes\n");
    const before = await snapshot(companion);
    const retirement = createGraphifyRetirementPlugin();
    const ctx = {
      companionPath: companion,
      config: { capabilities: [{ name: "openspec" }] },
      mode: "sync" as const,
      activeProviders: [],
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await retirement.teardown(ctx);
      await retirement.forProvider?.claude.teardown(ctx);
      await retirement.forProvider?.opencode.teardown(ctx);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
    expect(await snapshot(companion)).toEqual(before);
  });

  describe("Working Repository secret region", () => {
    const REGION =
      "# mate:secrets begin (managed by Mate; edits are overwritten)\n.env\n# mate:secrets end\n";

    async function makeRepo(ignore: string): Promise<string> {
      const repo = await makeTempDir("mate-retire-repo-");
      spawnSync("git", ["init", "-q"], { cwd: repo });
      await write(path.join(repo, ".graphifyignore"), ignore);
      await write(path.join(repo, ".git", "info", "exclude"), "/acme-local\n/.graphifyignore\n");
      return repo;
    }

    test("a Mate-only ignore file and its exclude line are removed", async () => {
      const repo = await makeRepo(REGION);
      await sync(await makeUsedCompanion(), repo);
      expect(await exists(path.join(repo, ".graphifyignore"))).toBe(false);
      expect(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8")).toBe(
        "/acme-local\n",
      );
    });

    test("user lines survive", async () => {
      const repo = await makeRepo(`vendor/\n\n${REGION}`);
      await sync(await makeUsedCompanion(), repo);
      expect(await fs.readFile(path.join(repo, ".graphifyignore"), "utf8")).toBe("vendor/\n");
    });

    test("an ignore file without Mate's region and its exclude line stay", async () => {
      const repo = await makeRepo("vendor/\r\n\r\n");
      await sync(await makeUsedCompanion(), repo);
      expect(await fs.readFile(path.join(repo, ".graphifyignore"), "utf8")).toBe("vendor/\r\n\r\n");
      expect(await fs.readFile(path.join(repo, ".git", "info", "exclude"), "utf8")).toBe(
        "/acme-local\n/.graphifyignore\n",
      );
    });
  });
});
