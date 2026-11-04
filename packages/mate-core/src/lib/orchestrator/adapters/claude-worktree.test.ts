import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_SETTINGS_DOCUMENT,
  EMPTY_MANIFEST,
  withDocument,
} from "../../../runtime/runtime-document-manifest";
import { wrapStateOf } from "../../../runtime/wrap-state";
import { getClaudePluginRoot } from "../../package-paths";
import type { PrepareResult } from "../session-prepare";
import type { AdapterContext } from "./base";
import { ClaudeAdapter } from "./claude";

const ID = "acme@acme";
const MARKETPLACE = "acme";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function worktreeFixture(separateGitDir = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acme-claude-worktree-"));
  roots.push(root);
  const original = path.join(root, "original");
  const worktree = path.join(root, "worktree");
  const companionPath = path.join(root, "companion");
  const originalPlugin = path.join(root, "plugin-original");
  const worktreePlugin = path.join(root, "plugin-worktree");
  await Promise.all(
    [original, companionPath, originalPlugin, worktreePlugin].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  git(
    original,
    "init",
    "-q",
    ...(separateGitDir ? ["--separate-git-dir", path.join(root, "git")] : []),
  );
  git(
    original,
    "-c",
    "user.name=Acme",
    "-c",
    "user.email=acme@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "acme",
  );
  git(original, "worktree", "add", "-q", "--detach", worktree);

  const settings = (plugin: string, enabledPlugins: Record<string, boolean> = { [ID]: true }) => ({
    enabledPlugins,
    extraKnownMarketplaces: {
      [MARKETPLACE]: { source: { source: "directory", path: plugin } },
    },
  });
  const writeSettings = async (checkout: string, value: unknown) => {
    const file = path.join(checkout, CLAUDE_SETTINGS_DOCUMENT);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  };
  await writeSettings(original, settings(originalPlugin));
  await writeSettings(worktree, settings(worktreePlugin));

  const wrapState = wrapStateOf(
    withDocument(EMPTY_MANIFEST, CLAUDE_SETTINGS_DOCUMENT, [
      {
        at: ["extraKnownMarketplaces"],
        kind: "map",
        entries: { [MARKETPLACE]: { source: { source: "directory", path: worktreePlugin } } },
      },
      { at: ["enabledPlugins"], kind: "map", entries: { [ID]: true } },
    ]),
  );
  const context: AdapterContext = {
    repository: { id: "acme", path: worktree },
    launchWorkingDirectory: worktree,
    allowedAgents: ["claude"],
    companionPath,
    capabilities: [],
  };
  const prepared: PrepareResult = {
    ok: true,
    mode: "attended",
    runtime: "claude",
    runtimes: ["claude"],
    repositoryId: "acme",
    companionPath,
    steps: [],
    warnings: [],
    wrapState,
    claudePluginDirectories: [worktreePlugin],
  };
  const pluginDirs = async () => {
    const adapter = new ClaudeAdapter();
    const launch = await adapter.planLaunch(context, prepared);
    const args = adapter.buildArgs(launch, []);
    return args.filter((_, index) => args[index - 1] === "--plugin-dir");
  };
  return {
    root,
    original,
    worktree,
    originalPlugin,
    worktreePlugin,
    settings,
    writeSettings,
    pluginDirs,
  };
}

describe("Claude launch in a linked worktree", () => {
  test("passes the worktree plugin when both Checkouts enable different sources", async () => {
    const fixture = await worktreeFixture();
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot(), fixture.worktreePlugin]);
  });

  test("does not guess when Git reports only a separate Git directory", async () => {
    const fixture = await worktreeFixture(true);
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("does not override an explicit disable in the original Checkout", async () => {
    const fixture = await worktreeFixture();
    await fixture.writeSettings(
      fixture.original,
      fixture.settings(fixture.originalPlugin, { [ID]: false }),
    );
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("leaves worktree-only enablement to the Wrap", async () => {
    const fixture = await worktreeFixture();
    await fixture.writeSettings(fixture.original, {});
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("leaves matching sources to the Wrap", async () => {
    const fixture = await worktreeFixture();
    await fixture.writeSettings(fixture.original, fixture.settings(fixture.worktreePlugin));
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("does not override a disabled Wrap plugin because another plugin ID shares its marketplace", async () => {
    const fixture = await worktreeFixture();
    await fixture.writeSettings(
      fixture.original,
      fixture.settings(fixture.originalPlugin, { [ID]: false, "other@acme": true }),
    );
    await fixture.writeSettings(
      fixture.worktree,
      fixture.settings(fixture.worktreePlugin, { [ID]: true, "other@acme": true }),
    );
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("does not override a worktree plugin the user disabled", async () => {
    const fixture = await worktreeFixture();
    await fixture.writeSettings(
      fixture.worktree,
      fixture.settings(fixture.worktreePlugin, { [ID]: false }),
    );
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("does not treat an unrelated worktree marketplace source as Wrap-carried", async () => {
    const fixture = await worktreeFixture();
    const unrelated = path.join(fixture.root, "unrelated-plugin");
    await fs.mkdir(unrelated);
    await fixture.writeSettings(fixture.worktree, fixture.settings(unrelated));
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test("keeps existing delivery if the original settings cannot be read", async () => {
    const fixture = await worktreeFixture();
    const file = path.join(fixture.original, CLAUDE_SETTINGS_DOCUMENT);
    await fs.rm(file);
    await fs.mkdir(file);
    expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
  });

  test.skipIf(process.platform === "win32")(
    "recognizes two paths to the same plugin folder",
    async () => {
      const fixture = await worktreeFixture();
      const alias = path.join(fixture.root, "plugin-alias");
      await fs.symlink(fixture.worktreePlugin, alias, "dir");
      await fixture.writeSettings(fixture.original, fixture.settings(alias));
      expect(await fixture.pluginDirs()).toEqual([getClaudePluginRoot()]);
    },
  );
});
