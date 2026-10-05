import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MATE_ENV } from "../runtime/env-names";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import type { MateSlotClaim, MateTuiApi } from "./tui";

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

function fakeApi(): { api: MateTuiApi; claims: MateSlotClaim[] } {
  const claims: MateSlotClaim[] = [];
  const api: MateTuiApi = {
    theme: { text: { muted: "#808080" } },
    ui: {
      slot(claim) {
        claims.push(claim);
        return () => {};
      },
    },
  };
  return { api, claims };
}

describe("Mate OpenCode TUI plugin", () => {
  test("default export is a V2 TUI plugin module", async () => {
    const { default: tuiPlugin } = await import("./tui");

    expect(typeof tuiPlugin.id).toBe("string");
    expect(tuiPlugin.id.length).toBeGreaterThan(0);
    expect(typeof tuiPlugin.setup).toBe("function");
    expect(tuiPlugin).not.toHaveProperty("tui");
  });

  test("claims home footer and sidebar placements from a projection when the environment is empty", async () => {
    const { repo } = await wrappedRepo();
    const { default: tuiPlugin } = await import("./tui");
    const { api, claims } = fakeApi();

    await inUnmanagedSession(repo, async () => tuiPlugin.setup(api));

    expect(claims.map(({ render: _render, ...placement }) => placement)).toEqual([
      { prepend: "home.footer" },
      { append: "sidebar.content" },
    ]);
    for (const claim of claims) expect(typeof claim.render).toBe("function");
  });

  test("claims nothing when neither the environment nor a projection resolves", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "mate-tui-unwrapped-"));
    tempRoots.push(bare);
    const { default: tuiPlugin } = await import("./tui");
    const { api, claims } = fakeApi();

    await inUnmanagedSession(bare, async () => tuiPlugin.setup(api));

    expect(claims).toHaveLength(0);
  });

  test("is exported through the core ./opencode/tui subpath, not the ./opencode barrel", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.resolve(import.meta.dirname, "..", "..", "package.json"), "utf8"),
    ) as { exports?: Record<string, string> };

    expect(packageJson.exports?.["./opencode/tui"]).toBe("./src/opencode/tui.tsx");
    expect(packageJson.exports?.["./opencode"]).toBe("./src/opencode/index.ts");

    const index = await fs.readFile(path.resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(index).not.toMatch(/from\s+["']\.\/tui["']/);
  });
});
