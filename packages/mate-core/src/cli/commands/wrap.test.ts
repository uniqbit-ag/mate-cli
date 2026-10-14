import { execFileSync } from "node:child_process";
import fs2 from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { FRAMEWORK_NAME } from "../../framework";
import { resolveForLaunch } from "../../lib/orchestrator/framework-context";
import { GlobalConfigStore } from "../../lib/orchestrator/global-config-store";
import { writeRepoLocalRegistryEntry } from "../../lib/orchestrator/repository-link";
import { runtimeDocumentDeps } from "../../lib/orchestrator/projection-runtime-documents";
import { project } from "../../lib/orchestrator/working-repo-projection";
import type { WrapPassResult } from "../../lib/orchestrator/wrap-pass";
import { EMPTY_MANIFEST, type WrapRuntime } from "../../runtime/runtime-document-manifest";
import { readWrapState, wrapStateOf } from "../../runtime/wrap-state";
import type { LinkedRepository } from "../../lib/orchestrator/types";
import { cleanupWorkingRepository } from "../../tools/setup/working-repo-cleanup";
import { parseWrapArgs, runWrapCommand } from "./wrap";

const tempRoots: string[] = [];
let originalExitCode: number | undefined;
const originalArtifactPath = process.env.MATE_ARTIFACT_PATH;
const originalHomeDir = runtimeDocumentDeps.homeDir;

beforeEach(() => {
  originalExitCode = process.exitCode;
  delete process.env.MATE_ARTIFACT_PATH;
  /**
   * Local-scope MCP writes to the user's home; never the real one from a test.
   * One stable directory per test, so a second wrap sees what the first wrote.
   */
  const home = fs2.mkdtempSync(path.join(os.tmpdir(), "mate-home-"));
  tempRoots.push(home);
  runtimeDocumentDeps.homeDir = () => home;
});

afterEach(async () => {
  runtimeDocumentDeps.homeDir = originalHomeDir;
  process.exitCode = originalExitCode ?? 0;
  if (originalArtifactPath === undefined) delete process.env.MATE_ARTIFACT_PATH;
  else process.env.MATE_ARTIFACT_PATH = originalArtifactPath;
  for (const root of tempRoots.splice(0)) {
    await fs.chmod(path.join(root, "working", `.${FRAMEWORK_NAME}`), 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

const projectionDir = (repoPath: string) => path.join(repoPath, `.${FRAMEWORK_NAME}`);
const yamlPath = (repoPath: string) => path.join(projectionDir(repoPath), "projection.yaml");
const envPath = (repoPath: string) => path.join(projectionDir(repoPath), "projection.env");

async function makeLinkedRepo(prefix: string): Promise<{
  repoPath: string;
  companionPath: string;
  otherCompanionPath: string;
  repository: LinkedRepository;
  store: GlobalConfigStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  const repoPath = path.join(root, "working");
  const companionPath = path.join(root, "companion");
  const otherCompanionPath = path.join(root, "other-companion");
  await fs.mkdir(repoPath, { recursive: true });
  await fs.mkdir(companionPath, { recursive: true });
  await fs.mkdir(otherCompanionPath, { recursive: true });
  const repository: LinkedRepository = { id: "app", path: repoPath };
  await writeRepoLocalRegistryEntry(repoPath, companionPath, repository, "git");
  const store = new GlobalConfigStore(path.join(root, "config.yaml"));
  await store.register(companionPath);
  return { repoPath, companionPath, otherCompanionPath, repository, store };
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void out.push(args.map(String).join(" ")),
  );
  const errorSpy = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void err.push(args.map(String).join(" ")),
  );
  return {
    out,
    err,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  };
}

describe("parseWrapArgs", () => {
  test("accepts no arguments", () => {
    expect(parseWrapArgs([])).toEqual({});
  });

  test("accepts both spellings of --companion", () => {
    expect(parseWrapArgs(["--companion", "/tmp/acme"])).toEqual({ companion: "/tmp/acme" });
    expect(parseWrapArgs(["--companion=/tmp/acme"])).toEqual({ companion: "/tmp/acme" });
  });

  test("rejects a missing value and unknown options", () => {
    expect(parseWrapArgs(["--companion"])).toEqual({ error: "--companion requires a path" });
    expect(parseWrapArgs(["--companion", "--json"])).toEqual({
      error: "--companion requires a path",
    });
    expect(parseWrapArgs(["--json"])).toEqual({ error: "unknown wrap option: --json" });
  });

  test("accepts both spellings of --audience and requires a name", () => {
    expect(parseWrapArgs(["--audience", "ba"])).toEqual({ audience: "ba" });
    expect(parseWrapArgs(["--audience=ba", "--companion", "/tmp/acme"])).toEqual({
      audience: "ba",
      companion: "/tmp/acme",
    });
    expect(parseWrapArgs(["--audience"])).toEqual({ error: "--audience requires a name" });
    expect(parseWrapArgs(["--audience="])).toEqual({ error: "--audience requires a name" });
  });
});

describe("runWrapCommand audiences", () => {
  async function run(argv: string[]) {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-audience-");
    const passes: unknown[] = [];
    const { out, err, restore } = capture();
    try {
      await runWrapCommand(argv, repoPath, {
        resolveLinkedCompanions: async () => [{ companionPath }] as never,
        runWrapPass: async (_companion, _repository, options) => {
          passes.push(options?.audience);
          return { kind: "failed", message: "stop here" };
        },
      });
    } finally {
      restore();
    }
    return { passes, out, err };
  }

  test("--audience records the named audience", async () => {
    expect((await run(["--audience", "ba"])).passes).toEqual(["ba"]);
  });

  test("no flag wraps for base, withdrawing a recorded audience", async () => {
    expect((await run([])).passes).toEqual([null]);
  });
});

describe("runWrapCommand", () => {
  test("writes the Projection Root and reports the companion it names", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-write-");
    const { out, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(out.join("\n")).toContain(`Wrapped app at ${projectionDir(repoPath)}`);
    expect(out.join("\n")).toContain(`Companion: ${companionPath}`);
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toContain(companionPath);
    expect(await fs.readFile(envPath(repoPath), "utf8")).toContain(companionPath);
  });

  test("links companion Claude skills without replacing project skills", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-claude-skills-");
    const source = path.join(companionPath, ".claude", "skills", "acme");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "acme skill\n", "utf8");
    const custom = path.join(repoPath, ".claude", "skills", "custom", "SKILL.md");
    await fs.mkdir(path.dirname(custom), { recursive: true });
    await fs.writeFile(custom, "user skill\n", "utf8");

    await runWrapCommand([], repoPath);

    const link = path.join(repoPath, ".claude", "skills", "acme");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(await fs.realpath(source));
    expect(await fs.readFile(custom, "utf8")).toBe("user skill\n");

    await cleanupWorkingRepository(repoPath, [companionPath]);

    await expect(fs.lstat(link)).rejects.toThrow();
    await expect(fs.readFile(path.join(source, "SKILL.md"), "utf8")).resolves.toBe("acme skill\n");
    await expect(fs.readFile(custom, "utf8")).resolves.toBe("user skill\n");
  });

  test("copies the companion .opencode folder and warns about a shadowed file", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-opencode-copies-");
    const configDir = path.join(companionPath, `.${FRAMEWORK_NAME}`, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(path.join(configDir, "framework.yaml"), "allowedAgents:\n  - opencode\n");
    for (const name of ["acme", "acme-shadowed"]) {
      await fs.mkdir(path.join(companionPath, ".opencode", "commands"), { recursive: true });
      await fs.writeFile(
        path.join(companionPath, ".opencode", "commands", `${name}.md`),
        `${name}\n`,
      );
    }
    const own = path.join(repoPath, ".opencode", "commands", "acme-shadowed.md");
    await fs.mkdir(path.dirname(own), { recursive: true });
    await fs.writeFile(own, "repo\n");
    const { out, err, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(await fs.readFile(path.join(repoPath, ".opencode", "commands", "acme.md"), "utf8")).toBe(
      "acme\n",
    );
    expect(await fs.readFile(own, "utf8")).toBe("repo\n");
    expect(out.join("\n")).toContain("Copies:    1 written");
    expect(err.join("\n")).toContain("acme-shadowed.md");
  });

  test("reports an unchanged Projection Root as already wrapped", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-idempotent-");
    await runWrapCommand([], repoPath);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");
    const { out, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain("Already wrapped");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("re-pins a different companion despite an unchanged stamp", async () => {
    const { repoPath, otherCompanionPath } = await makeLinkedRepo("wrap-repin-");
    await runWrapCommand([], repoPath);
    const { out, restore } = capture();

    try {
      await runWrapCommand(["--companion", otherCompanionPath], repoPath);
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain("Wrapped app at");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toContain(otherCompanionPath);
  });

  test("fails naming companion link when the repository has no Repository Link", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "wrap-unlinked-"));
    tempRoots.push(root);
    const { err, restore } = capture();

    try {
      await runWrapCommand([], root);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("not a working repository linked to a companion");
    expect(err.join("\n")).toContain(`${FRAMEWORK_NAME} companion link`);
    expect(await fs.exists(yamlPath(root))).toBe(false);
  });

  test("fails on an unknown option without writing", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-badflag-");
    const { err, restore } = capture();

    try {
      await runWrapCommand(["--json"], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown wrap option: --json");
    expect(await fs.exists(yamlPath(repoPath))).toBe(false);
  });

  test("exits non-zero on a failed write, leaving the previous projection intact", async () => {
    const { repoPath, otherCompanionPath } = await makeLinkedRepo("wrap-readonly-");
    await runWrapCommand([], repoPath);
    const before = await fs.readFile(yamlPath(repoPath), "utf8");
    await fs.chmod(projectionDir(repoPath), 0o555);
    const { err, restore } = capture();

    try {
      await runWrapCommand(["--companion", otherCompanionPath], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("failed to write the projection for app");
    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(before);
  });

  test("a failed projection pair still writes the runtime documents and exits non-zero", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-pair-failure-");
    await fs.mkdir(path.join(yamlPath(repoPath), "blocked"), { recursive: true });
    const { err, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("failed to write the projection for app");
    expect(await fs.exists(envPath(repoPath))).toBe(false);
    expect((await readWrapState(repoPath)).runtimes.has("claude")).toBe(true);
  });

  test("warns about a tracked runtime document when it writes it, and only then", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-tracked-");
    execFileSync("git", ["init", "-q"], { cwd: repoPath });
    await fs.mkdir(path.join(repoPath, ".claude"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".claude", "settings.local.json"), "{}\n");
    execFileSync("git", ["add", "--force", ".claude/settings.local.json"], { cwd: repoPath });

    const first = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      first.restore();
    }
    const second = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      second.restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(first.err.join("\n")).toContain(
      `${FRAMEWORK_NAME}: warning: .claude/settings.local.json is tracked by Git in app;`,
    );
    expect(first.err.join("\n")).toContain("git rm --cached .claude/settings.local.json");
    expect(
      await fs.readFile(path.join(repoPath, ".claude", "settings.local.json"), "utf8"),
    ).toContain(companionPath);
    expect(second.err.join("\n")).not.toContain("is tracked by Git");
  });

  test("prints the pass's warnings and changed paths without knowing their entry", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-injected-");
    const { out, err, restore } = capture();

    try {
      await runWrapCommand([], repoPath, {
        runWrapPass: async () => ({
          kind: "written",
          projectionRoot: projectionDir(repoPath),
          companionPath,
          documents: [],
          writtenDocuments: [],
          changed: { written: ["a", "b"], removed: ["c"] },
          warnings: ["acme needs attention"],
          runtimes: new Set(),
          wrapState: wrapStateOf(EMPTY_MANIFEST),
        }),
      });
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain("Copies:    2 written, 1 withdrawn under .opencode/");
    expect(err).toContain(`${FRAMEWORK_NAME}: warning: acme needs attention`);
  });

  test("writes what a launch resolution writes", async () => {
    const { repoPath, store } = await makeLinkedRepo("wrap-equivalence-");
    await runWrapCommand([], repoPath);
    const wrapped = {
      yaml: await fs.readFile(yamlPath(repoPath), "utf8"),
      env: await fs.readFile(envPath(repoPath), "utf8"),
    };

    await fs.rm(yamlPath(repoPath));
    await fs.rm(envPath(repoPath));
    await resolveForLaunch(repoPath, store);

    expect(await fs.readFile(yamlPath(repoPath), "utf8")).toBe(wrapped.yaml);
    expect(await fs.readFile(envPath(repoPath), "utf8")).toBe(wrapped.env);
  });

  test("working cleanup removes what wrap wrote", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-cleanup-");
    await runWrapCommand([], repoPath);

    expect(await fs.exists(path.join(repoPath, ".claude", "settings.local.json"))).toBe(true);

    await cleanupWorkingRepository(repoPath, [companionPath]);

    expect(await fs.exists(yamlPath(repoPath))).toBe(false);
    expect(await fs.exists(envPath(repoPath))).toBe(false);
    /** Cleanup holds no list of runtime documents; the catalogue does. */
    expect(await fs.exists(path.join(repoPath, ".claude"))).toBe(false);
  });

  test("a second wrap with no intervening change modifies no file", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-unchanged-");
    await runWrapCommand([], repoPath);
    const settingsPath = path.join(repoPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    await runWrapCommand([], repoPath);

    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  });

  test("exits non-zero naming the document, leaving the written projection in place", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-doc-failure-");
    const claudeDir = path.join(repoPath, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.chmod(claudeDir, 0o555);
    const { err, restore } = capture();

    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
      await fs.chmod(claudeDir, 0o755);
    }

    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain(path.join(".claude", "settings.local.json"));
    expect(await fs.exists(yamlPath(repoPath))).toBe(true);
  });

  test("says that both session kinds work here", async () => {
    const { repoPath } = await makeLinkedRepo("wrap-notice-");

    const { out, restore } = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    const printed = out.join("\n");
    expect(printed).toContain("`claude`");
    expect(printed).toContain(`\`${FRAMEWORK_NAME} claude\``);
    expect(printed).toContain("both work here");
    expect(printed).not.toContain("does not run");
    expect(printed).not.toContain("context-mode");
    expect(printed).toContain(`${FRAMEWORK_NAME} unwrap`);
  });

  test.each([
    ["Claude", ["claude"], ["claude"], ["opencode"]],
    ["OpenCode", ["opencode"], ["opencode"], ["claude"]],
  ] as const)(
    "a %s-only pass names only its runtime, whatever paths it changed",
    async (_label, covered, named, unnamed) => {
      const { repoPath, companionPath } = await makeLinkedRepo("wrap-runtimes-");
      const passed: WrapPassResult = {
        kind: "written",
        projectionRoot: projectionDir(repoPath),
        companionPath,
        documents: [],
        writtenDocuments: [],
        changed: { written: [".claude/skills/acme"], removed: [] },
        warnings: [],
        runtimes: new Set<WrapRuntime>(covered),
        wrapState: wrapStateOf(EMPTY_MANIFEST),
      };
      const { out, restore } = capture();
      try {
        await runWrapCommand([], repoPath, { runWrapPass: async () => passed });
      } finally {
        restore();
      }

      const notice = out.find((line) => line.startsWith("Start sessions")) ?? "";
      for (const tool of named) {
        expect(notice).toContain(`\`${tool}\``);
        expect(notice).toContain(`\`${FRAMEWORK_NAME} ${tool}\``);
      }
      for (const tool of unnamed) {
        expect(notice).not.toContain(`\`${tool}\``);
        expect(notice).not.toContain(`\`${FRAMEWORK_NAME} ${tool}\``);
      }
    },
  );

  test("notes that context-mode stays launch-only when it is enabled", async () => {
    const { repoPath, companionPath } = await makeLinkedRepo("wrap-context-mode-");
    await fs.mkdir(path.join(companionPath, `.${FRAMEWORK_NAME}`, "config"), { recursive: true });
    await fs.writeFile(
      path.join(companionPath, `.${FRAMEWORK_NAME}`, "config", "framework.yaml"),
      "allowedAgents:\n  - claude\ncapabilities:\n  - name: context-mode\n",
    );

    const { out, restore } = capture();
    try {
      await runWrapCommand([], repoPath);
    } finally {
      restore();
    }

    expect(out.join("\n")).toContain(
      `context-mode loads only in sessions started with \`${FRAMEWORK_NAME} claude\``,
    );
  });

  test("a managed launch does not reconcile the working target", async () => {
    const { repoPath, companionPath, store } = await makeLinkedRepo("wrap-launch-");
    await runWrapCommand([], repoPath);
    const settingsPath = path.join(repoPath, ".claude", "settings.local.json");
    const before = await fs.readFile(settingsPath, "utf8");

    await project("launch", {
      repoPath,
      companionPath,
      config: { allowedAgents: ["claude"], capabilities: [] },
      globalConfigStore: store,
    });

    expect(await fs.readFile(settingsPath, "utf8")).toBe(before);
  });
});
