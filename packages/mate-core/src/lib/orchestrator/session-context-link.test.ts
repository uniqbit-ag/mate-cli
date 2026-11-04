import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";

import {
  companionFrameworkConfigPath,
  policyDocument,
  readCompanionPolicy,
} from "../../runtime/policy";
import { writeProjectionPair } from "../../runtime/projection";
import { repoLocalRegistryPath } from "../../runtime/repo-local";
import { companionRegistryPath } from "./repository-link";
import { GlobalConfigStore } from "./global-config-store";
import { querySessionContext } from "./session-context-link";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  repoRoot: string;
  companionPath: string;
  configStore: GlobalConfigStore;
}

/**
 * A wrapped `acme-app` whose projection names the `acme` companion. The user's
 * Mate configuration registers `registered` companions; the companion's
 * registry links the `linked` repositories.
 */
function fixture(
  options: {
    registered?: (f: { companionPath: string; root: string }) => string[];
    linked?: (f: { repoRoot: string }) => Array<{ id: string; path: string }>;
  } = {},
): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-link-")));
  tempRoots.push(root);
  const repoRoot = path.join(root, "acme-app");
  const companionPath = path.join(root, "acme");
  fs.mkdirSync(companionPath, { recursive: true });

  fs.mkdirSync(path.dirname(repoLocalRegistryPath(repoRoot)), { recursive: true });
  fs.writeFileSync(repoLocalRegistryPath(repoRoot), "companions: []\n", "utf8");
  writeProjectionPair(repoRoot, {
    stamp: "stamp",
    projection: {
      version: "0.18.5",
      companionPath,
      repositoryPath: repoRoot,
      repositoryId: "acme-app",
      wrapperBinPath: "/w",
      reactDoctorBinPath: "/r",
      graphifyOut: "/g",
    },
  });

  const repos = (options.linked ?? ((f) => [{ id: "acme-app", path: f.repoRoot }]))({ repoRoot });
  fs.mkdirSync(path.dirname(companionRegistryPath(companionPath)), { recursive: true });
  fs.writeFileSync(companionRegistryPath(companionPath), stringify({ repos }), "utf8");

  const configPath = path.join(root, "home", ".mate", "config.yaml");
  const registered = (options.registered ?? ((f) => [f.companionPath]))({ companionPath, root });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    stringify({ version: 1, companions: registered.map((p) => ({ path: p })) }),
    "utf8",
  );

  return { root, repoRoot, companionPath, configStore: new GlobalConfigStore(configPath) };
}

async function codeOf(dir: string, configStore: GlobalConfigStore) {
  const result = await querySessionContext(dir, { configStore });
  return result.ok ? "ok" : result.error.code;
}

describe("querySessionContext", () => {
  test("reports a registered companion that links the repository", async () => {
    const { repoRoot, companionPath, configStore } = fixture();

    const result = await querySessionContext(repoRoot, { configStore });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.companionPath).toBe(companionPath);
  });

  test("matches a companion registered through a link to its folder", async () => {
    const { repoRoot, configStore } = fixture({
      registered: ({ companionPath, root }) => {
        const link = path.join(root, "acme-alias");
        fs.symlinkSync(companionPath, link);
        return [link];
      },
    });

    expect(await codeOf(repoRoot, configStore)).toBe("ok");
  });

  describe("a companion spelled with a link before `..`", () => {
    /** `<root>/d/fwd/../acme` leads to `<root>/acme`; `<root>/d/acme` is the decoy. */
    const configuredOf = (root: string) => `${root}/d/fwd/../acme`;

    function linkedFixture(registered: (f: { companionPath: string; root: string }) => string[]) {
      const f = fixture({ registered });
      const decoy = path.join(f.root, "d", "acme");
      fs.mkdirSync(path.join(f.root, "sub"), { recursive: true });
      fs.mkdirSync(path.dirname(companionRegistryPath(decoy)), { recursive: true });
      fs.symlinkSync(path.join(f.root, "sub"), path.join(f.root, "d", "fwd"));
      fs.writeFileSync(
        companionRegistryPath(decoy),
        stringify({ repos: [{ id: "acme-app", path: f.repoRoot }] }),
        "utf8",
      );
      for (const [dir, config] of [
        [f.companionPath, "git: auto\n"],
        [decoy, "git: manual\nsecrets:\n  guardrails: false\n"],
      ] as const) {
        fs.writeFileSync(companionFrameworkConfigPath(dir), config, "utf8");
      }
      return f;
    }

    function projectConfigured(repoRoot: string, companionPath: string) {
      writeProjectionPair(repoRoot, {
        stamp: "stamp",
        projection: {
          version: "0.18.5",
          companionPath,
          repositoryPath: repoRoot,
          repositoryId: "acme-app",
          wrapperBinPath: "/w",
          reactDoctorBinPath: "/r",
          graphifyOut: "/g",
        },
      });
    }

    test("a projection and registration with that spelling report where it leads, with its policy", async () => {
      const { root, repoRoot, companionPath, configStore } = linkedFixture((f) => [
        configuredOf(f.root),
      ]);
      projectConfigured(repoRoot, configuredOf(root));

      const result = await querySessionContext(repoRoot, { configStore });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.context.companionPath).toBe(companionPath);
      expect(result.context.policyJson).toBe(policyDocument(readCompanionPolicy(companionPath)));
    });

    test("a projection with that spelling matches the companion registered by its real path", async () => {
      const { root, repoRoot, companionPath, configStore } = linkedFixture((f) => [
        f.companionPath,
      ]);
      projectConfigured(repoRoot, configuredOf(root));

      const result = await querySessionContext(repoRoot, { configStore });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.context.companionPath).toBe(companionPath);
    });

    test("a registration with that spelling matches the projection's real path", async () => {
      const { repoRoot, configStore } = linkedFixture((f) => [configuredOf(f.root)]);
      expect(await codeOf(repoRoot, configStore)).toBe("ok");
    });

    test("the decoy's registration does not vouch for the companion the spelling leads to", async () => {
      const { root, repoRoot, configStore } = linkedFixture((f) => [
        path.join(f.root, "d", "acme"),
      ]);
      projectConfigured(repoRoot, configuredOf(root));
      expect(await codeOf(repoRoot, configStore)).toBe("companion-not-registered");
    });
  });

  test("refuses a planted projection naming a folder that is not a registered companion", async () => {
    const { repoRoot, configStore } = fixture({ registered: () => [] });

    const result = await querySessionContext(repoRoot, { configStore });

    expect(result).toEqual({
      ok: false,
      error: { code: "companion-not-registered", message: expect.any(String) },
    });
  });

  test("refuses a registered companion whose registry does not link the repository", async () => {
    const { repoRoot, configStore } = fixture({ linked: () => [] });

    expect(await codeOf(repoRoot, configStore)).toBe("repository-not-linked");
  });

  test("refuses a link whose ID matches but whose path does not", async () => {
    const { repoRoot, configStore } = fixture({
      linked: () => [{ id: "acme-app", path: "/elsewhere/acme-app" }],
    });

    expect(await codeOf(repoRoot, configStore)).toBe("repository-not-linked");
  });

  test("refuses a link whose path matches but whose ID does not", async () => {
    const { repoRoot, configStore } = fixture({
      linked: (f) => [{ id: "other", path: f.repoRoot }],
    });

    expect(await codeOf(repoRoot, configStore)).toBe("repository-not-linked");
  });

  test("refuses a companion without a registry", async () => {
    const { repoRoot, companionPath, configStore } = fixture();
    fs.rmSync(companionRegistryPath(companionPath));

    expect(await codeOf(repoRoot, configStore)).toBe("repository-not-linked");
  });

  test("lets a companion registry it cannot read fail the query instead of refusing the link", async () => {
    const { repoRoot, companionPath, configStore } = fixture();
    fs.writeFileSync(companionRegistryPath(companionPath), "repos: [\n  - id: : :\n", "utf8");
    await expect(querySessionContext(repoRoot, { configStore })).rejects.toThrow();

    fs.rmSync(companionRegistryPath(companionPath));
    fs.mkdirSync(companionRegistryPath(companionPath));
    await expect(querySessionContext(repoRoot, { configStore })).rejects.toThrow();
  });

  test("answers not-wrapped for a folder no projection covers", async () => {
    const { root, configStore } = fixture();
    const bare = path.join(root, "bare");
    fs.mkdirSync(bare);

    expect(await codeOf(bare, configStore)).toBe("not-wrapped");
  });

  test("answers companion-missing when the projected companion is gone", async () => {
    const { repoRoot, companionPath, configStore } = fixture();
    fs.rmSync(companionPath, { recursive: true, force: true });

    expect(await codeOf(repoRoot, configStore)).toBe("companion-missing");
  });

  test("answers companion-not-registered when the user has no Mate configuration", async () => {
    const { root, repoRoot } = fixture();
    const configStore = new GlobalConfigStore(path.join(root, "nobody", ".mate", "config.yaml"));

    expect(await codeOf(repoRoot, configStore)).toBe("companion-not-registered");
    expect(fs.existsSync(path.join(root, "nobody"))).toBe(false);
  });

  test("refuses a clone whose projection claims another linked checkout", async () => {
    const { root, repoRoot, companionPath, configStore } = fixture();
    const clone = path.join(root, "acme-clone");
    fs.mkdirSync(path.dirname(repoLocalRegistryPath(clone)), { recursive: true });
    fs.writeFileSync(repoLocalRegistryPath(clone), "companions: []\n", "utf8");
    writeProjectionPair(clone, {
      stamp: "stamp",
      projection: {
        version: "0.18.5",
        companionPath,
        repositoryPath: repoRoot,
        repositoryId: "acme-app",
        wrapperBinPath: "/w",
        reactDoctorBinPath: "/r",
        graphifyOut: "/g",
      },
    });

    const result = await querySessionContext(path.join(clone, "src"), { configStore });

    expect(result.ok ? "ok" : result.error.code).toBe("repository-not-linked");
    expect(await codeOf(repoRoot, configStore)).toBe("ok");
  });

  test("reports the checkout it validated, not the repository path the projection claims", async () => {
    const { root, repoRoot, companionPath, configStore } = fixture();
    writeProjectionPair(repoRoot, {
      stamp: "stamp",
      projection: {
        version: "0.18.5",
        companionPath,
        repositoryPath: path.join(root, "somewhere-else"),
        repositoryId: "acme-app",
        wrapperBinPath: "/w",
        reactDoctorBinPath: "/r",
        graphifyOut: "/g",
      },
    });

    const result = await querySessionContext(path.join(repoRoot, "src"), { configStore });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.repositoryPath).toBe(repoRoot);
  });

  test("lets an unreadable Mate configuration fail the query instead of refusing the companion", async () => {
    const { root, repoRoot } = fixture();
    const configPath = path.join(root, "home", ".mate", "config.yaml");
    fs.writeFileSync(configPath, "version: 1\ncompanions: [\n  - path: : :\n", "utf8");

    await expect(
      querySessionContext(repoRoot, { configStore: new GlobalConfigStore(configPath) }),
    ).rejects.toThrow();
  });

  test("reports the linked checkout for a folder below its root", async () => {
    const { repoRoot, configStore } = fixture();
    const below = path.join(repoRoot, "packages", "web");
    fs.mkdirSync(below, { recursive: true });

    expect(await codeOf(below, configStore)).toBe("ok");
  });

  test("skips malformed registrations instead of failing", async () => {
    const { root, repoRoot, companionPath } = fixture();
    const configPath = path.join(root, "home", ".mate", "config.yaml");
    fs.writeFileSync(
      configPath,
      stringify({ version: 1, companions: [{ path: null }, { path: 7 }, { path: companionPath }] }),
      "utf8",
    );

    expect(await codeOf(repoRoot, new GlobalConfigStore(configPath))).toBe("ok");
  });
});
