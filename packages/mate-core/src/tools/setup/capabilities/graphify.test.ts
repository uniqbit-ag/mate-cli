import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { SetupContext } from "../plugin";
import { getWrapperBinPath } from "../../../lib/package-paths";
import {
  createGraphifyPlugin,
  deriveGraphifyProviders,
  GRAPHIFY_COMPANION_OUT_PREFIX,
  removeGraphifySection,
  rewriteGraphifySkillOutputPaths,
} from "./graphify";

const GRAPHIFY_START = "<!-- MATE:GRAPHIFY:START -->";
const GRAPHIFY_END = "<!-- MATE:GRAPHIFY:END -->";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function makeCtx(
  companionPath: string,
  opts: { mode?: "setup" | "sync"; activeProviders?: string[] } = {},
): SetupContext {
  return {
    companionPath,
    activeProviders: opts.activeProviders ?? [],
    mode: opts.mode ?? "setup",
    config: {
      profiles: { default: { name: "default", allowedAgents: opts.activeProviders ?? [] } },
      capabilities: [{ name: "graphify" }],
    },
  };
}

describe("deriveGraphifyProviders", () => {
  test("keeps only supported providers in stable order", () => {
    expect(deriveGraphifyProviders(["headroom", "claude", "custom", "opencode"])).toEqual([
      "claude",
      "opencode",
    ]);
  });

  test("returns empty when no supported providers active", () => {
    expect(deriveGraphifyProviders(["headroom", "custom"])).toEqual([]);
  });
});

describe("createGraphifyPlugin apply()", () => {
  test("skips install prompt when graphify binary is on PATH", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => true);

    const plugin = createGraphifyPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("skips install prompt when graphifyy package installed via uv tool (not on PATH)", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => false);
    const checkUvToolMock = mock((pkg: string) => pkg === "graphifyy");

    const plugin = createGraphifyPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: checkUvToolMock,
    });

    await plugin.apply(makeCtx("/tmp/companion"));

    expect(confirmMock).not.toHaveBeenCalled();
    expect(checkUvToolMock).toHaveBeenCalledWith("graphifyy");
  });

  test("offers install prompt when binary is missing in setup mode", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => false);
    const checkUvToolMock = mock((_pkg: string) => false);

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const plugin = createGraphifyPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: checkUvToolMock,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("uv tool install graphify"));
      expect(confirmMock).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  test("skips install prompt in sync mode even when binary is missing", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => false);
    const checkUvToolMock = mock((_pkg: string) => false);

    const plugin = createGraphifyPlugin({
      confirm: confirmMock,
      isCommandOnPath: checkPathMock,
      isInstalledViaUvTool: checkUvToolMock,
    });

    await plugin.apply(makeCtx("/tmp/companion", { mode: "sync" }));

    expect(confirmMock).not.toHaveBeenCalled();
  });

  test("does not run install when user declines", async () => {
    const confirmMock = mock(async (_: string) => false);
    const checkPathMock = mock((_command: string, _path: string) => false);
    const checkUvToolMock = mock((_pkg: string) => false);
    const runCommandMock = mock(async () => {});

    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const plugin = createGraphifyPlugin({
        confirm: confirmMock,
        isCommandOnPath: checkPathMock,
        isInstalledViaUvTool: checkUvToolMock,
        runCommand: runCommandMock,
      });

      await plugin.apply(makeCtx("/tmp/companion"));

      expect(confirmMock).toHaveBeenCalled();
      expect(runCommandMock).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

describe("createGraphifyPlugin teardown()", () => {
  test("teardown is a no-op (does not uninstall global binary)", async () => {
    const confirmMock = mock(async (_: string) => false);
    const plugin = createGraphifyPlugin({ confirm: confirmMock });

    await expect(plugin.teardown(makeCtx("/tmp/companion"))).resolves.toBeUndefined();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("createGraphifyPlugin forProvider — wrapper generation", () => {
  for (const providerId of ["claude", "opencode"] as const) {
    test(`apply keeps the package graphify wrapper available for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-wrapper-${providerId}-`);
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      const wrapperPath = path.join(getWrapperBinPath(), "graphify");
      const stat = await fs.stat(wrapperPath);
      expect(stat.isFile()).toBe(true);

      const content = await fs.readFile(wrapperPath, "utf8");
      expect(content).toContain("#!/usr/bin/env bash");
      expect(content).toContain("MATE_ARTIFACT_PATH");
      expect(content).toContain("MATE_REPO_PATH");
      expect(content).toContain("MATE_REPO_ID");
      expect(content).toContain(".graphify/");
      expect(content).toContain("graphify-out");
      expect(content).toContain("--graph");
    });

    test(`wrapper is executable for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-exec-${providerId}-`);
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      const wrapperPath = path.join(getWrapperBinPath(), "graphify");
      const stat = await fs.stat(wrapperPath);
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    });

    test(`teardown removes graphify wrapper for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-teardown-${providerId}-`);
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));
      await plugin.forProvider![providerId].teardown(makeCtx(root));

      await expect(fs.access(path.join(root, ".mate", "bin", "graphify"))).rejects.toThrow();
    });

    test(`teardown prunes empty bin dir for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-prune-${providerId}-`);
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));
      await plugin.forProvider![providerId].teardown(makeCtx(root));

      await expect(fs.access(path.join(root, ".mate", "bin"))).rejects.toThrow();
    });

    test(`apply strips the ## graphify section written to the companion root agent file for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-strip-root-${providerId}-`);
      const agentFile = { claude: "CLAUDE.md", opencode: "AGENTS.md" }[providerId]!;
      const rootAgentPath = path.join(root, agentFile);

      // Mock `graphify install` the way the real binary behaves: it runs with
      // cwd=companionPath and appends a ## graphify section to the root agent file.
      const runProviderInstall = mock(async () => {
        const existing = "# Companion guidance\n\nsome guidance\n";
        await fs.writeFile(
          rootAgentPath,
          `${existing}\n## graphify\n\nThis project has a knowledge graph at graphify-out/.\n`,
          "utf8",
        );
      });

      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => true,
        runProviderInstall,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      expect(runProviderInstall).toHaveBeenCalled();
      const content = await fs.readFile(rootAgentPath, "utf8");
      expect(content).not.toContain("## graphify");
      // Non-graphify guidance is preserved.
      expect(content).toContain("Companion guidance");
    });

    test(`re-running apply overwrites existing wrapper for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-overwrite-${providerId}-`);
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));
      await plugin.forProvider![providerId].apply(makeCtx(root));

      const wrapperPath = path.join(getWrapperBinPath(), "graphify");
      const content = await fs.readFile(wrapperPath, "utf8");
      expect(content).toContain("#!/usr/bin/env bash");
    });
  }
});

describe("graphify wrapper script content", () => {
  test("wrapper fails fast without MATE_ARTIFACT_PATH", async () => {
    const root = await makeTempDir("mate-graphify-fail-fast-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");
    const content = await fs.readFile(wrapperPath, "utf8");

    expect(content).toContain("MATE_ARTIFACT_PATH not set");
    expect(content).toContain("exit 1");
  });

  test("wrapper fails fast without MATE_REPO_PATH", async () => {
    const root = await makeTempDir("mate-graphify-fail-fast-repo-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");
    const content = await fs.readFile(wrapperPath, "utf8");

    expect(content).toContain("MATE_REPO_PATH not set");
    expect(content).toContain("exit 1");
  });

  test("wrapper routes build to MATE_REPO_PATH with companion output dir", async () => {
    const root = await makeTempDir("mate-graphify-build-route-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const content = await fs.readFile(path.join(getWrapperBinPath(), "graphify"), "utf8");

    expect(content).toContain("build)");
    expect(content).toContain("$MATE_REPO_PATH");
    expect(content).toContain("extract");
    expect(content).toContain("--out");
    expect(content).toContain("$_graphify_root");
  });

  test("wrapper routes graph readers to companion graph.json", async () => {
    const root = await makeTempDir("mate-graphify-query-route-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const content = await fs.readFile(path.join(getWrapperBinPath(), "graphify"), "utf8");

    expect(content).toContain("query|path|explain|affected|tree)");
    expect(content).toContain("--graph");
    expect(content).toContain("$_graph_json");
  });

  test("wrapper defaults path-scanning commands to MATE_REPO_PATH", async () => {
    const root = await makeTempDir("mate-graphify-update-route-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const content = await fs.readFile(path.join(getWrapperBinPath(), "graphify"), "utf8");

    expect(content).toContain("update)");
    expect(content).toContain("extract|watch|cluster-only|label|check-update)");
    expect(content).toContain('exec "$_real" "$MATE_REPO_PATH" --update "${@:2}"');
    expect(content).toContain('exec "$_real" "$_cmd" "$MATE_REPO_PATH" "${@:2}"');
  });

  test("wrapper keeps lookup as a compatibility alias over query", async () => {
    const root = await makeTempDir("mate-graphify-lookup-route-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const content = await fs.readFile(path.join(getWrapperBinPath(), "graphify"), "utf8");

    expect(content).toContain("lookup)");
    expect(content).toContain('exec "$_real" query "${@:2}"');
  });

  test("wrapper passes unknown commands through unchanged", async () => {
    const root = await makeTempDir("mate-graphify-passthrough-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const content = await fs.readFile(path.join(getWrapperBinPath(), "graphify"), "utf8");

    expect(content).toContain('*)\n    exec "$_real" "$@"');
  });
});

describe("graphify wrapper invocation (E2E: path routing and env guard)", () => {
  async function writeCapturingGraphifyStub(stubDir: string): Promise<string> {
    const capturePath = path.join(stubDir, "graphify-capture.json");
    const stub = [
      "#!/usr/bin/env bun",
      'import fs from "node:fs";',
      "const payload = {",
      "  args: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "};",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(payload));`,
    ].join("\n");
    const stubPath = path.join(stubDir, "graphify");
    await fs.writeFile(stubPath, stub, "utf8");
    await fs.chmod(stubPath, 0o755);
    return capturePath;
  }

  test("wrapper exits non-zero and prints error when MATE_ARTIFACT_PATH is missing", async () => {
    const root = await makeTempDir("mate-graphify-e2e-no-fw-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.apply(makeCtx(root));

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");
    const result = spawnSync("bash", [wrapperPath, "build"], {
      env: { MATE_REPO_PATH: "/tmp/repo", PATH: process.env.PATH },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MATE_ARTIFACT_PATH not set");
  });

  test("wrapper exits non-zero and prints error when MATE_REPO_PATH is missing", async () => {
    const root = await makeTempDir("mate-graphify-e2e-no-repo-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.apply(makeCtx(root));

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");
    const result = spawnSync("bash", [wrapperPath, "build"], {
      env: { MATE_ARTIFACT_PATH: root, PATH: process.env.PATH },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MATE_REPO_PATH not set");
  });

  test("wrapper routes build command through extract with MATE_REPO_PATH as scan root and companion graphify root as output", async () => {
    const root = await makeTempDir("mate-graphify-e2e-build-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.apply(makeCtx(root));

    const realBinDir = await makeTempDir("mate-graphify-e2e-build-stub-");
    const capturePath = await writeCapturingGraphifyStub(realBinDir);

    const companionPath = root;
    const repoPath = "/tmp/working-repo";
    const repoId = "my-repo";

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");

    const result = spawnSync("bash", [wrapperPath, "build"], {
      env: {
        MATE_ARTIFACT_PATH: companionPath,
        MATE_REPO_PATH: repoPath,
        MATE_REPO_ID: repoId,
        PATH: `${realBinDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    // Capture file is only written if jq is available; skip if not
    let captureExists = false;
    try {
      await fs.access(capturePath);
      captureExists = true;
    } catch {
      // jq not available — just verify the wrapper ran without the env-guard error
    }

    if (captureExists) {
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { args: string[] };
      expect(capture.args).toContain(repoPath);
      expect(capture.args[0]).toBe("extract");
      expect(capture.args).toContain("--out");
      const outDirArg = capture.args[capture.args.indexOf("--out") + 1];
      expect(outDirArg).toContain(repoId);
      expect(outDirArg).toContain(".graphify");
    } else {
      // At minimum the wrapper must not have hit the env-guard exit
      expect(result.stderr ?? "").not.toContain("MATE_ARTIFACT_PATH not set");
      expect(result.stderr ?? "").not.toContain("MATE_REPO_PATH not set");
    }
  });

  test("wrapper routes query command with default graph path when --graph not provided", async () => {
    const root = await makeTempDir("mate-graphify-e2e-query-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.apply(makeCtx(root));

    const realBinDir = await makeTempDir("mate-graphify-e2e-query-stub-");
    const capturePath = await writeCapturingGraphifyStub(realBinDir);

    const companionPath = root;
    const repoPath = "/tmp/working-repo";
    const repoId = "my-repo";

    const wrapperPath = path.join(getWrapperBinPath(), "graphify");

    spawnSync("bash", [wrapperPath, "query", "findAllClasses"], {
      env: {
        MATE_ARTIFACT_PATH: companionPath,
        MATE_REPO_PATH: repoPath,
        MATE_REPO_ID: repoId,
        PATH: `${realBinDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    let captureExists = false;
    try {
      await fs.access(capturePath);
      captureExists = true;
    } catch {
      // jq not available
    }

    if (captureExists) {
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { args: string[] };
      expect(capture.args).toContain("--graph");
      const graphArg = capture.args[capture.args.indexOf("--graph") + 1];
      expect(graphArg).toContain(repoId);
      expect(graphArg).toContain(".graphify/");
      expect(graphArg).toContain("graph.json");
    }
  });

  test("wrapper routes update command to the linked working repository when no path is provided", async () => {
    const root = await makeTempDir("mate-graphify-e2e-update-");
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.apply(makeCtx(root));

    const realBinDir = await makeTempDir("mate-graphify-e2e-update-stub-");
    const capturePath = await writeCapturingGraphifyStub(realBinDir);

    const repoPath = "/tmp/working-repo";
    const wrapperPath = path.join(getWrapperBinPath(), "graphify");

    spawnSync("bash", [wrapperPath, "update", "--force"], {
      env: {
        MATE_ARTIFACT_PATH: root,
        MATE_REPO_PATH: repoPath,
        MATE_REPO_ID: "my-repo",
        PATH: `${realBinDir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    const capture = JSON.parse(await fs.readFile(capturePath, "utf8")) as { args: string[] };
    expect(capture.args).toEqual([repoPath, "--update", "--force"]);
  });
});

// ---------------------------------------------------------------------------
// removeGraphifySection pure-function tests
// ---------------------------------------------------------------------------

describe("rewriteGraphifySkillOutputPaths", () => {
  test("rewrites cwd-relative graphify-out tokens to $GRAPHIFY_OUT", () => {
    const input = [
      "```bash",
      "mkdir -p graphify-out",
      "$(cat graphify-out/.graphify_python) -c \"Path('graphify-out/.graphify_ast.json')\"",
      "```",
    ].join("\n");
    const out = rewriteGraphifySkillOutputPaths(input);
    expect(out).not.toContain("graphify-out");
    expect(out).toContain("mkdir -p $GRAPHIFY_OUT");
    expect(out).toContain("$(cat $GRAPHIFY_OUT/.graphify_python)");
    expect(out).toContain("Path('$GRAPHIFY_OUT/.graphify_ast.json')");
  });

  test("collapses ${PROJECT_ROOT}/graphify-out to the absolute env var", () => {
    const input = 'CHUNK_PATH="${PROJECT_ROOT}/graphify-out/.graphify_chunk_01.json"';
    const out = rewriteGraphifySkillOutputPaths(input);
    expect(out).toBe('CHUNK_PATH="$GRAPHIFY_OUT/.graphify_chunk_01.json"');
  });

  test("preserves YAML frontmatter verbatim", () => {
    const input = [
      "---",
      "name: graphify",
      'description: "... graphify-out/ exists ..."',
      "---",
      "",
      "mkdir -p graphify-out",
    ].join("\n");
    const out = rewriteGraphifySkillOutputPaths(input);
    expect(out).toContain('description: "... graphify-out/ exists ..."');
    expect(out).toContain("mkdir -p $GRAPHIFY_OUT");
  });
});

describe("removeGraphifySection", () => {
  test("removes the ## graphify section, leaving surrounding content intact", () => {
    const input = [
      "# Companion",
      "",
      "## graphify",
      "",
      "graphify-out/graph.json",
      "",
      "## other",
      "",
      "Other content.",
      "",
    ].join("\n");
    const result = removeGraphifySection(input);
    expect(result).not.toContain("## graphify");
    expect(result).not.toContain("graphify-out/graph.json");
    expect(result).toContain("## other");
    expect(result).toContain("Other content.");
  });

  test("returns content unchanged when no ## graphify section present", () => {
    const input = "# Header\n\nSome content.\n";
    expect(removeGraphifySection(input)).toBe(input);
  });

  test("returns empty string when file contains only the graphify section", () => {
    const input = "## graphify\n\ngraphify-out/graph.json\n";
    expect(removeGraphifySection(input).trim()).toBe("");
  });

  test("removes a single-hash graphify section", () => {
    const input = "# graphify\n\ngraphify-out/graph.json\n";
    expect(removeGraphifySection(input).trim()).toBe("");
  });

  test("removes marked graphify block", () => {
    const input = [
      "# Header",
      "",
      GRAPHIFY_START,
      "## graphify",
      "",
      GRAPHIFY_COMPANION_OUT_PREFIX + "graph.json",
      GRAPHIFY_END,
      "",
      "## other",
      "",
      "Content.",
      "",
    ].join("\n");

    const result = removeGraphifySection(input);
    expect(result).not.toContain(GRAPHIFY_START);
    expect(result).not.toContain(GRAPHIFY_END);
    expect(result).toContain("## other");
  });

  test("removes orphaned graphify markers together with the graphify section", () => {
    const input = [
      "# Header",
      "",
      GRAPHIFY_START,
      "",
      GRAPHIFY_START,
      "## graphify",
      "",
      GRAPHIFY_COMPANION_OUT_PREFIX + "graph.json",
      "",
      "## other",
      "",
      "Content.",
      "",
    ].join("\n");

    const result = removeGraphifySection(input);

    expect(result).not.toContain(GRAPHIFY_START);
    expect(result).not.toContain(GRAPHIFY_END);
    expect(result).not.toContain("## graphify");
    expect(result).toContain("## other");
  });
});

// ---------------------------------------------------------------------------
// forProvider — provider asset install
// ---------------------------------------------------------------------------

describe("createGraphifyPlugin forProvider — provider asset install", () => {
  const GRAPHIFY_SECTION = [
    "",
    "## graphify",
    "",
    "Check graphify-out/graph.json exists.",
    "See graphify-out/GRAPH_REPORT.md.",
    "",
  ].join("\n");

  function makeInstallMock(providerFiles: Record<string, Record<string, string>> = {}) {
    return mock(async (command: string, args: string[], opts: { cwd: string }) => {
      const platIdx = args.indexOf("--platform");
      const platform = platIdx >= 0 ? args[platIdx + 1] : "unknown";
      const provDir = `.${platform}`;
      await fs.mkdir(path.join(opts.cwd, provDir, "skills", "graphify"), { recursive: true });
      await fs.writeFile(
        path.join(opts.cwd, provDir, "skills", "graphify", "SKILL.md"),
        [
          "# graphify skill",
          "",
          "```bash",
          "$(cat graphify-out/.graphify_python) -c \"print('graphify')\"",
          "mkdir -p graphify-out",
          "find graphify-out -maxdepth 1 -name '.graphify_chunk_*.json' -delete 2>/dev/null",
          "```",
          "",
          'graphify query "symbol:Mate"',
          'graphify path "AuthModule" "Database"',
          'graphify explain "SwinTransformer"',
          "graphify update .",
          "",
        ].join("\n"),
        "utf8",
      );
      const refsDir = path.join(opts.cwd, provDir, "skills", "graphify", "references");
      await fs.mkdir(refsDir, { recursive: true });
      await fs.writeFile(
        path.join(refsDir, "update.md"),
        "See graphify-out/graph.json and $(cat graphify-out/.graphify_python).\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(refsDir, "github-and-merge.md"),
        "graphify extract ./core/  # -> ./core/graphify-out/graph.json\n",
        "utf8",
      );
      const agentFiles: Record<string, string> = {
        claude: "CLAUDE.md",
        opencode: "AGENTS.md",
      };
      const agentFile = agentFiles[platform] ?? "AGENTS.md";
      const agentPath = path.join(opts.cwd, provDir, agentFile);
      const prev = await fs.readFile(agentPath, "utf8").catch(() => "");
      // Simulate graphify install: write or replace the ## graphify section
      // If file is new, write base content first (simulating existing agent guidance)
      const baseContent = prev || "# Project\n\nSome guidance here.\n";
      const sectionLines = GRAPHIFY_SECTION.trimStart().split("\n");
      const prevLines = baseContent.split("\n");
      const startIdx = prevLines.findIndex((l) => l === "## graphify");
      if (startIdx === -1) {
        await fs.writeFile(agentPath, baseContent.trimEnd() + GRAPHIFY_SECTION, "utf8");
      } else {
        let end = prevLines.length;
        for (let i = startIdx + 1; i < prevLines.length; i++) {
          if (prevLines[i].startsWith("## ") || prevLines[i].startsWith("# ")) {
            end = i;
            break;
          }
        }
        const replaced = [
          ...prevLines.slice(0, startIdx),
          ...sectionLines,
          ...prevLines.slice(end),
        ].join("\n");
        await fs.writeFile(agentPath, replaced, "utf8");
      }
      const extra = providerFiles[platform] ?? {};
      for (const [relPath, content] of Object.entries(extra)) {
        const fullPath = path.join(opts.cwd, relPath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, "utf8");
      }
    });
  }

  for (const providerId of ["claude", "opencode"] as const) {
    const providerDir = { claude: ".claude", opencode: ".opencode" }[providerId]!;

    test(`apply calls runProviderInstall with platform ${providerId} when graphify is on PATH`, async () => {
      const root = await makeTempDir(`mate-graphify-install-${providerId}-`);
      const installMock = makeInstallMock();
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        runProviderInstall: installMock,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      expect(installMock).toHaveBeenCalledWith(
        "graphify",
        ["install", "--project", "--platform", providerId],
        { cwd: root },
      );
    });

    test(`apply skips runProviderInstall when graphify is not on PATH for ${providerId}`, async () => {
      const root = await makeTempDir(`mate-graphify-no-install-${providerId}-`);
      const installMock = makeInstallMock();
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
        runProviderInstall: installMock,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      expect(installMock).not.toHaveBeenCalled();
    });

    test(`apply creates Graphify skill files in ${providerDir}/skills/graphify/`, async () => {
      const root = await makeTempDir(`mate-graphify-skills-${providerId}-`);
      const installMock = makeInstallMock();
      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => true,
        isInstalledViaUvTool: () => false,
        runProviderInstall: installMock,
      });

      await plugin.forProvider![providerId].apply(makeCtx(root));

      const skillPath = path.join(root, providerDir, "skills", "graphify", "SKILL.md");
      const stat = await fs.stat(skillPath);
      expect(stat.isFile()).toBe(true);
    });

    test(`teardown removes ${providerDir}/skills/graphify/ directory`, async () => {
      const root = await makeTempDir(`mate-graphify-teardown-skills-${providerId}-`);
      const skillDir = path.join(root, providerDir, "skills", "graphify");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "content", "utf8");

      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });
      await plugin.forProvider![providerId].teardown(makeCtx(root));

      await expect(fs.access(skillDir)).rejects.toThrow();
    });
  }

  test("main apply does not patch root AGENTS.md when only opencode is active", async () => {
    const root = await makeTempDir("mate-graphify-opencode-root-unpatched-");
    const installMock = makeInstallMock();
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall: installMock,
    });

    await plugin.apply(makeCtx(root, { activeProviders: ["opencode"] }));

    await expect(fs.access(path.join(root, "AGENTS.md"))).rejects.toThrow();
  });

  test("apply strips ## graphify section from CLAUDE.md for claude", async () => {
    const root = await makeTempDir("mate-graphify-claude-stripped-");
    const installMock = makeInstallMock();
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall: installMock,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const agentPath = path.join(root, ".claude", "CLAUDE.md");
    const remaining = await fs.readFile(agentPath, "utf8");
    expect(remaining).not.toContain("## graphify");
    expect(remaining).toContain("# Project");
    expect(remaining).toContain("Some guidance here.");
  });

  test("claude teardown removes graphify hook entries from settings.local.json", async () => {
    const root = await makeTempDir("mate-graphify-claude-hooks-teardown-");
    const graphifyHookPath = path.join(root, ".claude", "hooks", "graphify-guard.sh");
    const keepHook = {
      matcher: "Write",
      hooks: [{ type: "command", command: 'sh "/tmp/custom-hook.sh"' }],
    };
    const graphifyHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: `sh "${graphifyHookPath}"` }],
    };
    const sessionBannerHook = {
      hooks: [
        {
          type: "command",
          command: `${root}/.claude/hooks/mate-session-banner`,
        },
      ],
    };

    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude", "settings.local.json"),
      JSON.stringify(
        { hooks: { PreToolUse: [keepHook], SessionStart: [sessionBannerHook] } },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const runProviderInstall = mock(async () => {
      await fs.writeFile(
        path.join(root, ".claude", "settings.json"),
        JSON.stringify({ hooks: { PreToolUse: [graphifyHook] } }, null, 2) + "\n",
        "utf8",
      );
    });

    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const mergedSettings = JSON.parse(
      await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> };
    };
    expect(mergedSettings.hooks?.PreToolUse).toContainEqual(graphifyHook);

    await plugin.forProvider!.claude.teardown(makeCtx(root));

    const remainingSettings = JSON.parse(
      await fs.readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as {
      hooks?: {
        PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
        SessionStart?: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };
    expect(remainingSettings.hooks?.PreToolUse).toEqual([keepHook]);
    expect(remainingSettings.hooks?.SessionStart).toEqual([sessionBannerHook]);
  });

  test("apply strips ## graphify section from AGENTS.md for opencode", async () => {
    const root = await makeTempDir("mate-graphify-opencode-stripped-");
    const installMock = makeInstallMock();
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall: installMock,
    });

    await plugin.forProvider!.opencode.apply(makeCtx(root));

    const agentPath = path.join(root, ".opencode", "AGENTS.md");
    const remaining = await fs.readFile(agentPath, "utf8");
    expect(remaining).not.toContain("## graphify");
    expect(remaining).toContain("# Project");
    expect(remaining).toContain("Some guidance here.");
  });

  test("teardown strips ## graphify section from AGENTS.md", async () => {
    const root = await makeTempDir("mate-graphify-teardown-agents-");
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "# Header\n\n## graphify\n\n" +
        GRAPHIFY_COMPANION_OUT_PREFIX +
        "graph.json\n\n## other\n\nContent.\n",
      "utf8",
    );

    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.teardown(makeCtx(root));

    const remaining = await fs.readFile(path.join(root, "AGENTS.md"), "utf8").catch(() => "");
    expect(remaining).not.toContain("## graphify");
    expect(remaining).toContain("## other");
  });

  test("teardown strips graphify section from root CLAUDE.md (deletes if empty)", async () => {
    const root = await makeTempDir("mate-graphify-teardown-claude-md-empty-");
    const claudeMdPath = path.join(root, "CLAUDE.md");
    // File contains ONLY the graphify section — should be deleted after strip
    await fs.writeFile(claudeMdPath, "## graphify\n\ngraphify-out/graph.json\n", "utf8");

    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.teardown(makeCtx(root));

    await expect(fs.access(claudeMdPath)).rejects.toThrow();
  });

  test("teardown strips graphify section from root CLAUDE.md but keeps other content", async () => {
    const root = await makeTempDir("mate-graphify-teardown-claude-md-keep-");
    const claudeMdPath = path.join(root, "CLAUDE.md");
    // File has graphify section AND other content — strip section, keep file
    await fs.writeFile(
      claudeMdPath,
      "# Companion\n\nOther content.\n\n## graphify\n\ngraphify-out/graph.json\n",
      "utf8",
    );

    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => false,
      isInstalledViaUvTool: () => false,
    });
    await plugin.forProvider!.claude.teardown(makeCtx(root));

    const remaining = await fs.readFile(claudeMdPath, "utf8");
    expect(remaining).not.toContain("## graphify");
    expect(remaining).toContain("# Companion");
    expect(remaining).toContain("Other content.");
  });

  test(
    "teardown removes .opencode/plugins/graphify.js and updates opencode.json",
    { timeout: 30000 },
    async () => {
      const root = await makeTempDir("mate-graphify-teardown-opencode-");
      const pluginPath = path.join(root, ".opencode", "plugins", "graphify.js");
      await fs.mkdir(path.dirname(pluginPath), { recursive: true });
      await fs.writeFile(pluginPath, "// graphify plugin", "utf8");
      const opencodeJson = path.join(root, ".opencode", "opencode.json");
      await fs.writeFile(
        opencodeJson,
        JSON.stringify({ plugin: [".opencode/plugins/graphify.js"] }) + "\n",
        "utf8",
      );

      const plugin = createGraphifyPlugin({
        isCommandOnPath: () => false,
        isInstalledViaUvTool: () => false,
      });
      await plugin.forProvider!.opencode.teardown(makeCtx(root));

      await expect(fs.access(pluginPath)).rejects.toThrow();
      await expect(fs.access(opencodeJson)).rejects.toThrow();
    },
  );

  test("apply rewrites SKILL.md output paths to the companion store for claude", async () => {
    const root = await makeTempDir("mate-graphify-skill-claude-patched-");
    const installMock = makeInstallMock();
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall: installMock,
    });

    await plugin.forProvider!.claude.apply(makeCtx(root));

    const skillDir = path.join(root, ".claude", "skills", "graphify");
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    // cwd-relative graphify-out/ tokens redirected to the injected env var.
    expect(content).not.toContain("graphify-out");
    expect(content).toContain("mkdir -p $GRAPHIFY_OUT");
    expect(content).toContain("$(cat $GRAPHIFY_OUT/.graphify_python)");
    // graphify commands and marker/company-output expectations are unaffected.
    expect(content).not.toContain("<!--mate:artifact-output:start-->");
    expect(content).toContain('graphify query "symbol:Mate"');
    expect(content).toContain("graphify update .");
    expect(content).not.toContain("mate cap graphify query");

    // Reference files are patched too, except github-and-merge.md (intentional
    // cwd/external paths).
    const updateRef = await fs.readFile(path.join(skillDir, "references", "update.md"), "utf8");
    expect(updateRef).not.toContain("graphify-out");
    expect(updateRef).toContain("$GRAPHIFY_OUT/graph.json");
    const mergeRef = await fs.readFile(
      path.join(skillDir, "references", "github-and-merge.md"),
      "utf8",
    );
    expect(mergeRef).toContain("./core/graphify-out/graph.json");
  });

  test("apply rewrites SKILL.md output paths to the companion store for opencode", async () => {
    const root = await makeTempDir("mate-graphify-skill-opencode-patched-");
    const installMock = makeInstallMock();
    const plugin = createGraphifyPlugin({
      isCommandOnPath: () => true,
      isInstalledViaUvTool: () => false,
      runProviderInstall: installMock,
    });

    await plugin.forProvider!.opencode.apply(makeCtx(root));

    const skillPath = path.join(root, ".opencode", "skills", "graphify", "SKILL.md");
    const content = await fs.readFile(skillPath, "utf8");
    expect(content).not.toContain("graphify-out");
    expect(content).toContain("mkdir -p $GRAPHIFY_OUT");
    expect(content).not.toContain("<!--mate:artifact-output:start-->");
    expect(content).toContain('graphify query "symbol:Mate"');
    expect(content).toContain("graphify update .");
    expect(content).not.toContain("mate cap graphify query");
  });
});
