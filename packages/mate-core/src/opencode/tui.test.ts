import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function wrappedRepo(): Promise<{ repo: string; companion: string }> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tui-wrapped-"));
  tempRoots.push(repo);
  const companion = path.join(repo, "companion");
  await fs.mkdir(companion, { recursive: true });
  const registryPath = repoLocalRegistryPath(repo);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, "companions: []\n", "utf8");
  writeProjectionPair(repo, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath: companion,
      repositoryPath: repo,
      repositoryId: "acme",
      wrapperBinPath: path.join(companion, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companion, "react-doctor"),
      graphifyOut: path.join(companion, ".graphify", "acme", "graphify-out"),
    },
  });
  return { repo, companion };
}

async function inUnmanagedSession<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const previousEnv = new Map<string, string | undefined>();
  for (const name of Object.values(MATE_ENV)) {
    previousEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previousCwd);
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe("Mate OpenCode TUI plugin", () => {
  test("keeps full home/sidebar content and adds a compact active-session footer", async () => {
    const source = await fs.readFile(path.resolve(import.meta.dirname, "./tui.tsx"), "utf8");

    expect(source).toContain("slots: {\n      home_bottom()");
    expect(source).toContain("sidebar_content()");
    expect(source).toContain("app_bottom()");
    expect(source).toContain("api.renderer.width >= NARROW_TERMINAL_WIDTH");
    expect(source).toContain('api.route.current.name !== "session"');
    expect(source).toContain("compact />");
    expect(source).toContain("sidebar />");
    expect(source).toContain("order: 0");
    expect(source).toContain("mate v{MATE_VERSION}");
    expect(source).toContain("context.stalenessLines.map");
    expect(source).not.toContain("managed session");
    expect(source).not.toContain("showToast");
  });

  test("registers its slots from a projection when the environment is empty", async () => {
    const { repo } = await wrappedRepo();
    const { default: tuiPlugin } = await import("./tui");
    const registered: unknown[] = [];
    const api = { slots: { register: (entry: unknown) => registered.push(entry) } };

    await inUnmanagedSession(repo, () => tuiPlugin.tui(api as never));

    expect(registered).toHaveLength(1);
  });

  test("registers nothing when neither the environment nor a projection resolves", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tui-unwrapped-"));
    tempRoots.push(bare);
    const { default: tuiPlugin } = await import("./tui");
    const registered: unknown[] = [];
    const api = { slots: { register: (entry: unknown) => registered.push(entry) } };

    await inUnmanagedSession(bare, () => tuiPlugin.tui(api as never));

    expect(registered).toHaveLength(0);
  });

  test("is exported through the core ./opencode subpath", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.["./opencode"]).toBe("./src/opencode/index.ts");

    const index = await fs.readFile(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(index).toContain('export { default as tuiPlugin } from "./tui"');
  });
});
