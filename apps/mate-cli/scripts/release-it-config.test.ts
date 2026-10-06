import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import YAML from "yaml";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workspacePackageJsonPath = path.join(repoRoot, "package.json");
const stableReleaseConfigPath = path.join(repoRoot, ".release-it.json");
const canaryReleaseConfigPath = path.join(repoRoot, ".release-it.canary.json");
const lefthookConfigPath = path.join(repoRoot, "lefthook.yml");
const gitlabCiPath = path.join(repoRoot, ".gitlab-ci.yml");
const publishScriptPath = path.join(repoRoot, "publish.sh");
const readmePath = path.join(repoRoot, "README.md");
const packageJsonPath = path.join(repoRoot, "apps/mate-cli/package.json");
const releaseWorkflowPath = path.join(repoRoot, ".github/workflows/release.yml");
const codeownersPath = path.join(repoRoot, ".github/CODEOWNERS");
const allowedSignersPath = path.join(repoRoot, ".github/allowed_signers");
const PUBLISHED_PACKAGES = [
  ["packages/mate-core", "@uniqbit/mate-core"],
  ["apps/mate-opencode-plugin", "@uniqbit/mate-opencode-plugin"],
  ["apps/mate-cli", "@uniqbit/mate"],
] as const;

type ReleaseConfig = {
  hooks?: {
    [hookName: string]: string[] | undefined;
  };
  git?: {
    tagExclude?: string;
    commitArgs?: string[];
    tagArgs?: string[];
  };
  npm?: {
    publish?: boolean;
  };
  plugins?: Record<string, unknown>;
};

type PackageJson = {
  name?: string;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
  scripts?: Record<string, string | undefined>;
  publishConfig?: {
    access?: string;
    registry?: string;
  };
};

type LefthookConfig = {
  "pre-commit"?: {
    commands?: {
      format?: {
        stage_fixed?: boolean;
      };
    };
  };
};

async function createTempRepo(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);

  execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Mate Tests"], {
    cwd: tempDir,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "mate-tests@example.com"], {
    cwd: tempDir,
    stdio: "ignore",
  });

  return tempDir;
}

async function commitFile(repoDir: string, content: string, message: string) {
  const filePath = path.join(repoDir, "notes.txt");
  await fs.writeFile(filePath, `${content}\n`, "utf8");
  execFileSync("git", ["add", "notes.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], {
    cwd: repoDir,
    stdio: "ignore",
  });
}

const FIXTURE_PACK_CONTENT = "acme-tarball";

function packIntegrity(content: string): string {
  return `sha512-${createHash("sha512").update(content).digest("base64")}`;
}

const FIXTURE_INTEGRITY = packIntegrity(FIXTURE_PACK_CONTENT);

type PublishFixture = {
  binDir: string;
  callsPath: string;
  registryDir: string;
  scriptPath: string;
  version: string;
};

type PublishOptions = {
  /** `null` runs outside GitHub Actions. */
  workflowRef?: string | null;
  refName?: string;
  releaseTagArg?: string;
  packContent?: string;
  failPublishFor?: string;
};

async function createPublishFixture(
  version: string,
  overrides: Partial<Record<"core" | "plugin" | "cli", string>> = {},
): Promise<PublishFixture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-publish-"));
  tempDirs.push(tempDir);

  const binDir = path.join(tempDir, "bin");
  const scriptPath = path.join(tempDir, "publish.sh");
  const callsPath = path.join(tempDir, "npm-calls.txt");
  const registryDir = path.join(tempDir, "registry");

  await fs.mkdir(binDir);
  await fs.mkdir(registryDir);
  await fs.copyFile(publishScriptPath, scriptPath);

  const workspacePackages: Array<["core" | "plugin" | "cli", string, string]> = [
    ["core", "packages/mate-core", "@uniqbit/mate-core"],
    ["plugin", "apps/mate-opencode-plugin", "@uniqbit/mate-opencode-plugin"],
    ["cli", "apps/mate-cli", "@uniqbit/mate"],
  ];
  for (const [key, dir, name] of workspacePackages) {
    const packageDir = path.join(tempDir, dir);
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name, version: overrides[key] ?? version })}\n`,
      "utf8",
    );
  }

  const lockDir = path.join(tempDir, "apps/mate-container/locks");
  await fs.mkdir(lockDir, { recursive: true });
  const lockEntries = (names: string[]) =>
    Object.fromEntries(
      names.map((name) => [`node_modules/${name}`, { version, integrity: FIXTURE_INTEGRITY }]),
    );
  await fs.writeFile(
    path.join(lockDir, "global-tools.package-lock.json"),
    JSON.stringify({ packages: lockEntries(workspacePackages.map(([, , name]) => name)) }),
    "utf8",
  );
  await fs.writeFile(
    path.join(lockDir, "local-workspace.package-lock.json"),
    JSON.stringify({
      packages: lockEntries(["@uniqbit/mate-core", "@uniqbit/mate-opencode-plugin"]),
    }),
    "utf8",
  );

  const fakeNpmPath = path.join(binDir, "npm");
  await fs.writeFile(
    fakeNpmPath,
    [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$*" >> "$NPM_CALLS_PATH"',
      'if [ "$1" = view ]; then',
      '  entry="$FAKE_REGISTRY_DIR/$(printf "%s" "$2" | sed "s/^@//; s#/#-#")"',
      '  if [ -f "$entry" ]; then cat "$entry"; exit 0; fi',
      '  echo "npm error code E404" >&2',
      "  exit 1",
      "fi",
      'workspace=""; dest=""; prev=""',
      'for arg in "$@"; do',
      '  case "$prev" in --workspace) workspace="$arg" ;; --pack-destination) dest="$arg" ;; esac',
      '  prev="$arg"',
      "done",
      'if [ "$1" = publish ] && [ "$workspace" = "${FAKE_PUBLISH_FAIL_FOR:-}" ]; then',
      '  echo "npm error code E404" >&2',
      "  exit 1",
      "fi",
      'if [ -n "$dest" ]; then',
      '  file=$(printf "%s" "$workspace" | sed "s/^@//; s#/#-#")',
      '  printf "%s" "$FAKE_PACK_CONTENT" > "$dest/$file-$FAKE_PACK_VERSION.tgz"',
      "fi",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(fakeNpmPath, 0o755);

  return { binDir, callsPath, registryDir, scriptPath, version };
}

/** Marks `name@version` as already on the fake registry with `integrity`. */
async function seedRegistry(fixture: PublishFixture, name: string, integrity: string) {
  const file = `${name.replace(/^@/, "").replace("/", "-")}@${fixture.version}`;
  await fs.writeFile(path.join(fixture.registryDir, file), `${integrity}\n`, "utf8");
}

function runPublish(fixture: PublishFixture, tag: string, options: PublishOptions = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    NPM_CALLS_PATH: fixture.callsPath,
    FAKE_REGISTRY_DIR: fixture.registryDir,
    FAKE_PACK_CONTENT: options.packContent ?? FIXTURE_PACK_CONTENT,
    FAKE_PACK_VERSION: fixture.version,
    FAKE_PUBLISH_FAIL_FOR: options.failPublishFor ?? "",
    GITHUB_REF_NAME: options.refName ?? fixture.version,
  };
  delete env.NPM_TOKEN;

  const workflowRef =
    options.workflowRef === undefined
      ? `acme/acme/.github/workflows/release.yml@refs/tags/${fixture.version}`
      : options.workflowRef;
  if (workflowRef === null) {
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_WORKFLOW_REF;
  } else {
    env.GITHUB_ACTIONS = "true";
    env.GITHUB_WORKFLOW_REF = workflowRef;
  }

  const args = [fixture.scriptPath, tag];
  if (options.releaseTagArg !== undefined) args.push(options.releaseTagArg);
  return spawnSync("bash", args, { encoding: "utf8", env });
}

async function publishCalls(fixture: PublishFixture): Promise<string[]> {
  const calls = await fs.readFile(fixture.callsPath, "utf8").catch(() => "");
  return calls.split("\n").filter((line) => line.startsWith("publish "));
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("stable release-it config", () => {
  test("runs root release scripts from the package cwd instead of through workspace filters", async () => {
    const workspacePackageJson = JSON.parse(
      await fs.readFile(workspacePackageJsonPath, "utf8"),
    ) as PackageJson;

    expect(workspacePackageJson.scripts?.release).toBe("bun run --cwd ./apps/mate-cli release");
    expect(workspacePackageJson.scripts?.["release:canary"]).toBe(
      "bun run --cwd ./apps/mate-cli release:canary",
    );
    expect(workspacePackageJson.scripts?.["release:dry-run"]).toBe(
      "bun run --cwd ./apps/mate-cli release:dry-run",
    );
  });

  test("keeps tests in stable releases", async () => {
    const config = JSON.parse(await fs.readFile(stableReleaseConfigPath, "utf8")) as ReleaseConfig;

    expect(config.hooks?.["before:init"]).toContain("bun run test");
  });

  test("ignores canary tags when selecting the previous release tag", async () => {
    const config = JSON.parse(await fs.readFile(stableReleaseConfigPath, "utf8")) as ReleaseConfig;
    const tagExclude = config.git?.tagExclude;

    expect(tagExclude).toBe("*-*");

    const repoDir = await createTempRepo("mate-release-tags-");

    await commitFile(repoDir, "stable release", "feat: stable base");
    execFileSync("git", ["tag", "0.6.0"], { cwd: repoDir, stdio: "ignore" });

    await commitFile(repoDir, "first canary", "feat: first canary");
    execFileSync("git", ["tag", "0.7.0-canary.0"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    await commitFile(repoDir, "second canary", "fix: second canary");
    execFileSync("git", ["tag", "0.7.0-canary.1"], {
      cwd: repoDir,
      stdio: "ignore",
    });

    await commitFile(repoDir, "final release prep", "docs: final release prep");

    const latestTagWithoutExclude = execFileSync(
      "git",
      ["describe", "--tags", "--match=*", "--abbrev=0"],
      { cwd: repoDir, encoding: "utf8" },
    ).trim();

    const latestStableTag = execFileSync(
      "git",
      ["describe", "--tags", "--match=*", `--exclude=${tagExclude}`, "--abbrev=0"],
      { cwd: repoDir, encoding: "utf8" },
    ).trim();

    expect(latestTagWithoutExclude).toBe("0.7.0-canary.1");
    expect(latestStableTag).toBe("0.6.0");
  });

  test("restages formatter changes before release commits", async () => {
    const config = YAML.parse(await fs.readFile(lefthookConfigPath, "utf8")) as LefthookConfig;

    expect(config["pre-commit"]?.commands?.format?.stage_fixed).toBe(true);
  });

  test("prepares stable and canary releases without publishing locally", async () => {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageJson;

    expect(packageJson.scripts?.release).toBe("release-it --config ../../.release-it.json");
    expect(packageJson.scripts?.["release:canary"]).toBe(
      "release-it --config ../../.release-it.canary.json --preRelease=canary",
    );
    for (const script of [packageJson.scripts?.release, packageJson.scripts?.["release:canary"]]) {
      expect(script).not.toContain("publish.sh");
      expect(script).not.toContain("npm publish");
    }
    for (const configPath of [stableReleaseConfigPath, canaryReleaseConfigPath]) {
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as ReleaseConfig;
      expect(config.npm?.publish).toBe(false);
    }
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
  });

  test("keeps changelog generation stable-only", async () => {
    const stableConfig = JSON.parse(
      await fs.readFile(stableReleaseConfigPath, "utf8"),
    ) as ReleaseConfig;
    const canaryConfig = JSON.parse(
      await fs.readFile(canaryReleaseConfigPath, "utf8"),
    ) as ReleaseConfig;

    expect(stableConfig.plugins?.["@release-it/conventional-changelog"]).toBeDefined();
    expect(canaryConfig.plugins?.["@release-it/conventional-changelog"]).toBeUndefined();
  });

  test("removes GitLab CI configuration", async () => {
    await expect(fs.access(gitlabCiPath)).rejects.toThrow();
  });

  test("documents npm install as the supported public install path", async () => {
    const readme = await fs.readFile(readmePath, "utf8");

    expect(readme).toContain("npm install -g @uniqbit/mate");
    expect(readme).not.toContain("bun add -g @uniqbit/mate");
  });
});

describe("signed release preparation", () => {
  test("signs the release commit and the annotated release tag on both channels", async () => {
    for (const configPath of [stableReleaseConfigPath, canaryReleaseConfigPath]) {
      const config = JSON.parse(await fs.readFile(configPath, "utf8")) as ReleaseConfig;

      expect(config.git?.commitArgs).toEqual(["-S"]);
      expect(config.git?.tagArgs).toEqual(["-s"]);
    }
  });

  test("fails before creating a commit when no signing key is usable", async () => {
    const repoDir = await createTempRepo("mate-release-signing-");
    await fs.writeFile(path.join(repoDir, "notes.txt"), "acme\n", "utf8");
    execFileSync("git", ["add", "notes.txt"], { cwd: repoDir, stdio: "ignore" });

    const result = spawnSync(
      "git",
      [
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${path.join(repoDir, "missing-key")}`,
        "commit",
        "-S",
        "-m",
        "chore(release): 1.2.3",
      ],
      { cwd: repoDir, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoDir });
    expect(head.status).not.toBe(0);
  });
});

describe("published package metadata", () => {
  test("declares the source repository so provenance binds to it", async () => {
    for (const [dir, name] of PUBLISHED_PACKAGES) {
      const packageJson = JSON.parse(
        await fs.readFile(path.join(repoRoot, dir, "package.json"), "utf8"),
      ) as PackageJson;

      expect(packageJson.name).toBe(name);
      expect(packageJson.repository).toEqual({
        type: "git",
        url: "git+https://github.com/uniqbit-ag/mate-cli.git",
        directory: dir,
      });
    }
  });
});

describe("sync-release-versions", () => {
  const syncScriptPath = path.join(repoRoot, "apps/mate-cli/scripts/sync-release-versions.ts");

  test("release-it runs the version sync after every bump on both channels", async () => {
    const stableConfig = JSON.parse(
      await fs.readFile(stableReleaseConfigPath, "utf8"),
    ) as ReleaseConfig;
    const canaryConfig = JSON.parse(
      await fs.readFile(canaryReleaseConfigPath, "utf8"),
    ) as ReleaseConfig;

    expect(stableConfig.hooks?.["after:bump"]).toContain("bun scripts/sync-release-versions.ts");
    expect(canaryConfig.hooks?.["after:bump"]).toContain("bun scripts/sync-release-versions.ts");
  });

  test("propagates the bumped CLI version to core, plugin, and dependency pins", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-sync-versions-"));
    tempDirs.push(workspaceDir);

    execFileSync("git", ["init"], { cwd: workspaceDir, stdio: "ignore" });
    await fs.writeFile(
      path.join(workspaceDir, "package.json"),
      `${JSON.stringify({ name: "fixture", private: true, workspaces: ["apps/*", "packages/*"] })}\n`,
      "utf8",
    );
    const fixturePackages = [
      ["apps/mate-cli", { name: "@uniqbit/mate", version: "1.5.0-canary.2" }],
      ["apps/mate-opencode-plugin", { name: "@uniqbit/mate-opencode-plugin", version: "1.4.0" }],
      ["packages/mate-core", { name: "@uniqbit/mate-core", version: "1.4.0" }],
    ] as const;
    for (const [dir, contents] of fixturePackages) {
      await fs.mkdir(path.join(workspaceDir, dir), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, dir, "package.json"),
        `${JSON.stringify(contents)}\n`,
        "utf8",
      );
    }

    const result = spawnSync("bun", [syncScriptPath, workspaceDir], {
      cwd: workspaceDir,
      encoding: "utf8",
    });
    expect(result.stderr).not.toContain("failed");
    expect(result.status).toBe(0);

    const cli = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "apps/mate-cli/package.json"), "utf8"),
    );
    const plugin = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "apps/mate-opencode-plugin/package.json"), "utf8"),
    );
    const core = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "packages/mate-core/package.json"), "utf8"),
    );

    expect(core.version).toBe("1.5.0-canary.2");
    expect(plugin.version).toBe("1.5.0-canary.2");
    expect(plugin.dependencies["@uniqbit/mate-core"]).toBe("1.5.0-canary.2");
    expect(cli.dependencies["@uniqbit/mate-core"]).toBe("1.5.0-canary.2");
    expect(cli.dependencies["@uniqbit/mate-opencode-plugin"]).toBe("1.5.0-canary.2");

    // The touched manifests are staged so they land in the release commit.
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: workspaceDir,
      encoding: "utf8",
    });
    expect(staged).toContain("apps/mate-cli/package.json");
    expect(staged).toContain("apps/mate-opencode-plugin/package.json");
    expect(staged).toContain("packages/mate-core/package.json");
  });
});

describe("publish.sh", () => {
  test("publishes stable and canary versions with provenance through npmjs.org without a real registry", async () => {
    for (const [version, tag] of [
      ["1.2.3", "latest"],
      ["1.3.0-canary.4", "canary"],
    ] as const) {
      const fixture = await createPublishFixture(version);
      const result = runPublish(fixture, tag);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const calls = await fs.readFile(fixture.callsPath, "utf8");
      expect(calls).toContain("pack --dry-run --workspace @uniqbit/mate-core");
      expect(calls).toContain("pack --dry-run --workspace @uniqbit/mate-opencode-plugin");
      expect(calls).toContain("pack --dry-run --workspace @uniqbit/mate");
      for (const name of ["@uniqbit/mate-core", "@uniqbit/mate-opencode-plugin", "@uniqbit/mate"]) {
        expect(calls).toContain(
          `publish --workspace ${name} --access public --tag ${tag} --provenance --registry https://registry.npmjs.org/`,
        );
      }

      // Core and plugin must publish before the CLI that pins them.
      expect((await publishCalls(fixture)).map((line) => line.split(" ")[2])).toEqual([
        "@uniqbit/mate-core",
        "@uniqbit/mate-opencode-plugin",
        "@uniqbit/mate",
      ]);
    }
  });

  test("uses no long-lived npm token", async () => {
    const publishScript = await fs.readFile(publishScriptPath, "utf8");

    expect(publishScript).not.toContain("NPM_TOKEN");
    expect(publishScript).not.toContain("_authToken");
    expect(publishScript).not.toContain("NPM_CONFIG_USERCONFIG");
  });

  test("refuses to run outside the hosted release workflow before invoking npm", async () => {
    for (const workflowRef of [null, "acme/acme/.github/workflows/ci.yml@refs/heads/main"]) {
      const fixture = await createPublishFixture("1.2.3");
      const result = runPublish(fixture, "latest", { workflowRef });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("only runs inside the release workflow");
      expect(result.stderr).toContain(".github/workflows/release.yml");
      expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
    }
  });

  test("publishes nothing when a packed tarball differs from the image lock pins", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "latest", { packContent: "acme-changed" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `@uniqbit/mate-core@1.2.3 would publish as ${packIntegrity("acme-changed")}, but global-tools.package-lock.json, local-workspace.package-lock.json pin another tarball`,
    );
    expect(await publishCalls(fixture)).toEqual([]);
  });

  test("rejects unsynchronized package versions before invoking npm", async () => {
    const fixture = await createPublishFixture("1.2.3", { plugin: "1.2.2" });
    const result = runPublish(fixture, "latest");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("synchronized versions");
    expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
  });

  test("rejects unsupported dist-tags before invoking npm", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "next");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected latest or canary");
    expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
  });

  test("rejects unsupported version shapes before invoking npm", async () => {
    const fixture = await createPublishFixture("1.3.0-next.1");
    const result = runPublish(fixture, "canary");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected x.y.z (latest) or x.y.z-canary.n (canary)");
    expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
  });

  test("rejects stable and canary channel mismatches", async () => {
    const stableFixture = await createPublishFixture("1.2.3");
    const canaryFixture = await createPublishFixture("1.3.0-canary.4");

    const stableAsCanary = runPublish(stableFixture, "canary");
    const canaryAsLatest = runPublish(canaryFixture, "latest");

    expect(stableAsCanary.status).not.toBe(0);
    expect(stableAsCanary.stderr).toContain("cannot be published with dist-tag canary");
    expect(canaryAsLatest.status).not.toBe(0);
    expect(canaryAsLatest.stderr).toContain("cannot be published with dist-tag latest");
    expect(await fs.stat(stableFixture.callsPath).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(canaryFixture.callsPath).catch(() => undefined)).toBeUndefined();
  });

  test("rejects a release tag that differs from the package versions and names the package", async () => {
    for (const options of [{ refName: "1.2.4" }, { refName: "main", releaseTagArg: "1.2.4" }]) {
      const fixture = await createPublishFixture("1.2.3");
      const result = runPublish(fixture, "latest", options);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("release tag '1.2.4'");
      expect(result.stderr).toContain("@uniqbit/mate-core");
      expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
    }
  });

  test("takes the release tag from the argument when the run is not tag-triggered", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "latest", { refName: "main", releaseTagArg: "1.2.3" });

    expect(result.status).toBe(0);
    expect(await publishCalls(fixture)).toHaveLength(3);
  });

  test("completes a partial publication by skipping packages already published with the same integrity", async () => {
    const fixture = await createPublishFixture("1.2.3");
    await seedRegistry(fixture, "@uniqbit/mate-core", FIXTURE_INTEGRITY);

    const result = runPublish(fixture, "latest");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping @uniqbit/mate-core@1.2.3");
    expect((await publishCalls(fixture)).map((line) => line.split(" ")[2])).toEqual([
      "@uniqbit/mate-opencode-plugin",
      "@uniqbit/mate",
    ]);
  });

  test("stops before publishing further packages when a published version has another integrity", async () => {
    const fixture = await createPublishFixture("1.2.3");
    await seedRegistry(fixture, "@uniqbit/mate-opencode-plugin", packIntegrity("acme-other"));

    const result = runPublish(fixture, "latest");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `@uniqbit/mate-opencode-plugin@1.2.3 is already published as ${packIntegrity("acme-other")}`,
    );
    expect((await publishCalls(fixture)).map((line) => line.split(" ")[2])).toEqual([
      "@uniqbit/mate-core",
    ]);
  });

  test("names the trusted publisher when npm rejects a publication", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "latest", { failPublishFor: "@uniqbit/mate-core" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("trusted publisher");
    expect((await publishCalls(fixture)).map((line) => line.split(" ")[2])).toEqual([
      "@uniqbit/mate-core",
    ]);
  });

  test("does not repeat release preparation checks or request the image", async () => {
    const publishScript = await fs.readFile(publishScriptPath, "utf8");

    expect(publishScript).not.toContain("bun install");
    expect(publishScript).not.toContain("bun run --filter @uniqbit/mate typecheck");
    expect(publishScript).not.toContain("gh workflow run");
  });
});

type WorkflowStep = { uses?: string; run?: string; env?: Record<string, string> };
type WorkflowJob = {
  needs?: string | string[];
  environment?: string | { name?: string };
  permissions?: Record<string, string>;
  "continue-on-error"?: boolean;
  steps?: WorkflowStep[];
};
type Workflow = {
  on?: { push?: { tags?: string[] }; workflow_dispatch?: { inputs?: Record<string, unknown> } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

describe("release workflow", () => {
  async function readWorkflow(): Promise<{ source: string; workflow: Workflow }> {
    const source = await fs.readFile(releaseWorkflowPath, "utf8");
    return { source, workflow: YAML.parse(source) as Workflow };
  }

  test("runs for pushed release tags and for a dispatched tag, one run per tag", async () => {
    const { workflow } = await readWorkflow();

    expect(workflow.on?.push?.tags).toEqual(["[0-9]*.[0-9]*.[0-9]*"]);
    expect(workflow.on?.workflow_dispatch?.inputs?.tag).toBeDefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency?.group).toContain("release-");
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  test("pins every action to a full commit SHA", async () => {
    const { workflow } = await readWorkflow();
    const uses = Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
    );

    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  test("grants OIDC token issuance only to the publish job in the bound environment", async () => {
    const { workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};

    for (const [name, job] of Object.entries(jobs)) {
      expect(job.permissions?.["id-token"]).toBe(name === "publish" ? "write" : undefined);
    }
    expect(jobs.publish?.environment).toBe("npm-publish");
    expect(jobs.publish?.needs).toEqual(["verify"]);
  });

  test("references no npm token secret", async () => {
    const { source } = await readWorkflow();

    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("NODE_AUTH_TOKEN");
    expect(source).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
  });

  test("verifies the signed tag against the default-branch allowed signers before publication", async () => {
    const { workflow } = await readWorkflow();
    const verify = (workflow.jobs?.verify?.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(verify).toContain("+refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG");
    expect(verify).toContain("git show origin/main:.github/allowed_signers");
    expect(verify).toContain("gpg.format=ssh");
    expect(verify).toContain("verify-tag");
    expect(verify).toContain("merge-base --is-ancestor");
  });

  test("publishes through the shared publication entrypoint", async () => {
    const { workflow } = await readWorkflow();
    const publish = (workflow.jobs?.publish?.steps ?? []).map((step) => step.run ?? "").join("\n");

    expect(publish).toContain("bun install --frozen-lockfile");
    expect(publish).toContain("./publish.sh");
    expect(publish).toMatch(/npm@11\.\d+\.\d+/);
  });

  test("requests the image only after publication, without failing the release", async () => {
    const { workflow } = await readWorkflow();
    const image = workflow.jobs?.image;

    expect(image?.needs).toContain("publish");
    expect(image?.["continue-on-error"]).toBe(true);
    expect(image?.permissions).toEqual({ actions: "write" });
  });
});

describe("release trust anchors", () => {
  test("lists at least one SSH signing key with an email principal", async () => {
    const signers = (await fs.readFile(allowedSignersPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));

    expect(signers.length).toBeGreaterThan(0);
    for (const line of signers) {
      expect(line).toMatch(/^\S+@\S+ (namespaces="git" )?ssh-(ed25519|rsa) \S+/);
    }
  });

  test("assigns code owners to release-critical files", async () => {
    const codeowners = await fs.readFile(codeownersPath, "utf8");

    for (const file of [
      "/.github/workflows/release.yml",
      "/.github/allowed_signers",
      "/publish.sh",
    ]) {
      expect(codeowners).toMatch(new RegExp(`^${file.replaceAll(".", "\\.")}\\s+@\\S+`, "m"));
    }
  });
});

describe("canary release-it config", () => {
  test("skips tests but keeps typechecking", async () => {
    const config = JSON.parse(await fs.readFile(canaryReleaseConfigPath, "utf8")) as ReleaseConfig;

    expect(config.hooks?.["before:init"]).not.toContain("bun run test");
    expect(config.hooks?.["before:init"]).toContain("bun run typecheck");
  });
});
