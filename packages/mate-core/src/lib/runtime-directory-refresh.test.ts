import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  refreshRuntimeDirectory,
  stableInterpreterPath,
  type RuntimeDirectoryTargets,
} from "./runtime-directory-refresh";
import {
  runtimeClaudeCapabilityPluginsRoot,
  runtimeClaudePluginRoot,
  runtimeDirectoryPath,
  runtimeMateBin,
  runtimeOpenCodePluginRoot,
  runtimeWrapperBinPath,
} from "../runtime/runtime-directory";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

async function install(root: string): Promise<RuntimeDirectoryTargets> {
  const pluginRoot = path.join(root, "opencode-plugin");
  const claudePluginRoot = path.join(root, "claude-plugin");
  const claudeCapabilityPluginsRoot = path.join(root, "claude-capability-plugins");
  const wrapperBinPath = path.join(root, "wrappers", "bin");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.mkdir(claudePluginRoot, { recursive: true });
  await fs.mkdir(claudeCapabilityPluginsRoot, { recursive: true });
  await fs.mkdir(wrapperBinPath, { recursive: true });
  const cliEntry = path.join(root, "cli.mjs");
  await fs.writeFile(cliEntry, 'console.log("acme-version");\n');
  return {
    pluginRoot,
    claudePluginRoot,
    claudeCapabilityPluginsRoot,
    wrapperBinPath,
    execPath: process.execPath,
    cliEntry,
  };
}

describe("runtime directory paths", () => {
  test("live under <mate home>/runtime", () => {
    const home = "/home/acme";
    expect(runtimeDirectoryPath(home)).toBe(path.join(home, ".mate", "runtime"));
    expect(runtimeOpenCodePluginRoot(home)).toBe(
      path.join(home, ".mate", "runtime", "opencode-plugin"),
    );
    expect(runtimeClaudePluginRoot(home)).toBe(
      path.join(home, ".mate", "runtime", "claude-plugin"),
    );
    expect(runtimeClaudeCapabilityPluginsRoot(home)).toBe(
      path.join(home, ".mate", "runtime", "claude-capability-plugins"),
    );
    expect(runtimeWrapperBinPath(home)).toBe(
      path.join(home, ".mate", "runtime", "wrappers", "bin"),
    );
    expect(runtimeMateBin(home, "linux")).toBe(path.join(home, ".mate", "runtime", "bin", "mate"));
    expect(runtimeMateBin(home, "win32")).toBe(
      path.join(home, ".mate", "runtime", "bin", "mate.cmd"),
    );
  });
});

describe("stableInterpreterPath", () => {
  async function versionedInterpreter(): Promise<{ root: string; versioned: string }> {
    const root = await makeTempDir("acme-interpreter-");
    const versioned = path.join(root, "Cellar", "acme", "1.0.0", "bin", "acme");
    await fs.mkdir(path.dirname(versioned), { recursive: true });
    await fs.writeFile(versioned, "");
    return { root, versioned };
  }

  test("prefers a PATH link that resolves to the running interpreter", async () => {
    const { root, versioned } = await versionedInterpreter();
    const linkDir = path.join(root, "bin");
    await fs.mkdir(linkDir);
    await fs.symlink(versioned, path.join(linkDir, "acme"));

    const pathValue = [path.dirname(versioned), linkDir].join(path.delimiter);
    expect(stableInterpreterPath(versioned, pathValue)).toBe(path.join(linkDir, "acme"));
  });

  test("ignores a same-named PATH entry that is another interpreter", async () => {
    const { root, versioned } = await versionedInterpreter();
    const otherDir = path.join(root, "other");
    await fs.mkdir(otherDir);
    await fs.writeFile(path.join(otherDir, "acme"), "");

    expect(stableInterpreterPath(versioned, otherDir)).toBe(versioned);
  });

  test("keeps the resolved path when no PATH entry links to it", async () => {
    const { versioned } = await versionedInterpreter();
    expect(stableInterpreterPath(versioned, undefined)).toBe(versioned);
  });
});

describe("refreshRuntimeDirectory", () => {
  test("links the plugin root and wrappers, and writes a launcher", async () => {
    const home = await makeTempDir("acme-home-");
    const targets = await install(await makeTempDir("acme-install-"));

    const result = await refreshRuntimeDirectory(targets, home);

    expect(result.changed.sort()).toEqual([
      "bin/mate",
      "claude-capability-plugins",
      "claude-plugin",
      "opencode-plugin",
      "wrappers",
    ]);
    expect(await fs.realpath(runtimeOpenCodePluginRoot(home))).toBe(targets.pluginRoot);
    expect(await fs.realpath(runtimeClaudePluginRoot(home))).toBe(targets.claudePluginRoot);
    expect(await fs.realpath(runtimeClaudeCapabilityPluginsRoot(home))).toBe(
      targets.claudeCapabilityPluginsRoot,
    );
    expect(await fs.realpath(runtimeWrapperBinPath(home))).toBe(targets.wrapperBinPath);
    /** A `.cmd` launcher runs only through a shell on Windows. */
    const run = spawnSync(runtimeMateBin(home), ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("acme-version");
  });

  test("an unchanged install leaves every entry unmodified", async () => {
    const home = await makeTempDir("acme-home-");
    const targets = await install(await makeTempDir("acme-install-"));
    await refreshRuntimeDirectory(targets, home);
    const before = await fs.lstat(runtimeMateBin(home));
    const linkBefore = await fs.lstat(runtimeOpenCodePluginRoot(home));

    const result = await refreshRuntimeDirectory(targets, home);

    expect(result.changed).toEqual([]);
    expect((await fs.lstat(runtimeMateBin(home))).mtimeMs).toBe(before.mtimeMs);
    expect((await fs.lstat(runtimeOpenCodePluginRoot(home))).ino).toBe(linkBefore.ino);
  });

  test("a link spelled differently but resolving to its target is current", async () => {
    const home = await makeTempDir("acme-home-");
    const installRoot = await makeTempDir("acme-install-");
    const targets = await install(installRoot);
    await refreshRuntimeDirectory(targets, home);
    /** A Windows junction reads back `\\?\`-prefixed; an alias spelling stands in for it. */
    const alias = path.join(path.dirname(installRoot), `${path.basename(installRoot)}-alias`);
    await fs.symlink(installRoot, alias, process.platform === "win32" ? "junction" : "dir");
    tempRoots.push(alias);
    const link = runtimeClaudePluginRoot(home);
    await fs.unlink(link);
    await fs.symlink(
      path.join(alias, "claude-plugin"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await refreshRuntimeDirectory(targets, home);

    expect(result.changed).toEqual([]);
  });

  test("a different install re-points the links and rewrites the launcher", async () => {
    const home = await makeTempDir("acme-home-");
    await refreshRuntimeDirectory(await install(await makeTempDir("acme-install-a-")), home);
    const next = await install(await makeTempDir("acme-install-b-"));

    const result = await refreshRuntimeDirectory(next, home);

    expect(result.changed.sort()).toEqual([
      "bin/mate",
      "claude-capability-plugins",
      "claude-plugin",
      "opencode-plugin",
      "wrappers",
    ]);
    expect(await fs.realpath(runtimeOpenCodePluginRoot(home))).toBe(next.pluginRoot);
    expect(await fs.realpath(runtimeClaudePluginRoot(home))).toBe(next.claudePluginRoot);
    expect(await fs.realpath(runtimeClaudeCapabilityPluginsRoot(home))).toBe(
      next.claudeCapabilityPluginsRoot,
    );
    expect(await fs.realpath(runtimeWrapperBinPath(home))).toBe(next.wrapperBinPath);
    expect(await fs.readFile(runtimeMateBin(home), "utf8")).toContain(next.cliEntry);
  });

  test("replaces a stray directory where a link belongs", async () => {
    const home = await makeTempDir("acme-home-");
    const targets = await install(await makeTempDir("acme-install-"));
    await fs.mkdir(path.join(runtimeOpenCodePluginRoot(home), "stale"), { recursive: true });

    await refreshRuntimeDirectory(targets, home);

    expect((await fs.lstat(runtimeOpenCodePluginRoot(home))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(runtimeOpenCodePluginRoot(home))).toBe(targets.pluginRoot);
  });
});
