import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import YAML from "yaml";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const workspacePackageJsonPath = path.join(repoRoot, "package.json");
const stableReleaseConfigPath = path.join(repoRoot, ".release-it.json");
const canaryReleaseConfigPath = path.join(repoRoot, ".release-it.canary.json");
const lefthookConfigPath = path.join(repoRoot, "lefthook.yml");
const gitlabCiPath = path.join(repoRoot, ".gitlab-ci.yml");
const publishScriptPath = path.join(repoRoot, "publish.sh");
const readmePath = path.join(repoRoot, "README.md");
const packageJsonPath = path.join(repoRoot, "apps/mate-cli/package.json");

type ReleaseConfig = {
  hooks?: {
    [hookName: string]: string[] | undefined;
  };
  git?: {
    tagExclude?: string;
  };
  plugins?: Record<string, unknown>;
};

type PackageJson = {
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

type PublishFixture = {
  binDir: string;
  callsPath: string;
  npmrcCapturePath: string;
  scriptPath: string;
};

async function createPublishFixture(version: string): Promise<PublishFixture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mate-publish-"));
  tempDirs.push(tempDir);

  const packageDir = path.join(tempDir, "apps/mate-cli");
  const binDir = path.join(tempDir, "bin");
  const scriptPath = path.join(tempDir, "publish.sh");
  const callsPath = path.join(tempDir, "npm-calls.txt");
  const npmrcCapturePath = path.join(tempDir, "captured.npmrc");

  await fs.mkdir(packageDir, { recursive: true });
  await fs.mkdir(binDir);
  await fs.copyFile(publishScriptPath, scriptPath);
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@uniqbit/mate", version })}\n`,
    "utf8",
  );

  const fakeNpmPath = path.join(binDir, "npm");
  await fs.writeFile(
    fakeNpmPath,
    [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$*" >> "$NPM_CALLS_PATH"',
      'cp "$NPM_CONFIG_USERCONFIG" "$NPMRC_CAPTURE_PATH"',
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(fakeNpmPath, 0o755);

  return { binDir, callsPath, npmrcCapturePath, scriptPath };
}

function runPublish(fixture: PublishFixture, tag: string, npmToken: string | null = "test-token") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    NPM_CALLS_PATH: fixture.callsPath,
    NPMRC_CAPTURE_PATH: fixture.npmrcCapturePath,
  };

  if (npmToken === null) {
    delete env.NPM_TOKEN;
  } else {
    env.NPM_TOKEN = npmToken;
  }

  return spawnSync("bash", [fixture.scriptPath, tag], {
    encoding: "utf8",
    env,
  });
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

  test("chains stable and canary releases to the shared publish script", async () => {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageJson;

    expect(packageJson.scripts?.release).toBe(
      "release-it --config ../../.release-it.json && ../../publish.sh latest",
    );
    expect(packageJson.scripts?.["release:canary"]).toBe(
      "release-it --config ../../.release-it.canary.json --preRelease=canary && ../../publish.sh canary",
    );
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

  test("documents local releases and publication retries", async () => {
    const readme = await fs.readFile(readmePath, "utf8");

    expect(readme).toContain('export NPM_TOKEN="<npmjs-token>"');
    expect(readme).toContain("bun release:canary");
    expect(readme).toContain("./publish.sh latest");
    expect(readme).toContain("do not\nrerun release-it");
  });
});

describe("publish.sh", () => {
  test("publishes stable and canary versions through npmjs.org without a real registry", async () => {
    for (const [version, tag] of [
      ["1.2.3", "latest"],
      ["1.3.0-canary.4", "canary"],
    ] as const) {
      const fixture = await createPublishFixture(version);
      const result = runPublish(fixture, tag);

      expect(result.status).toBe(0);
      const calls = await fs.readFile(fixture.callsPath, "utf8");
      expect(calls).toContain("pack --dry-run --workspace @uniqbit/mate");
      expect(calls).toContain(`publish --workspace @uniqbit/mate --access public --tag ${tag}`);

      const npmrc = await fs.readFile(fixture.npmrcCapturePath, "utf8");
      expect(npmrc).toContain("registry=https://registry.npmjs.org/");
      expect(npmrc).toContain("//registry.npmjs.org/:_authToken=test-token");
      expect(npmrc).toContain("@uniqbit:registry=https://registry.npmjs.org/");
    }
  });

  test("rejects unsupported dist-tags before invoking npm", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "next");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected latest or canary");
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
  });

  test("requires NPM_TOKEN before invoking npm", async () => {
    const fixture = await createPublishFixture("1.2.3");
    const result = runPublish(fixture, "latest", null);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NPM_TOKEN environment variable is not set");
    expect(await fs.stat(fixture.callsPath).catch(() => undefined)).toBeUndefined();
  });

  test("does not repeat release preparation checks", async () => {
    const publishScript = await fs.readFile(publishScriptPath, "utf8");

    expect(publishScript).not.toContain("bun install");
    expect(publishScript).not.toContain("bun run --filter @uniqbit/mate typecheck");
  });
});

describe("canary release-it config", () => {
  test("skips tests but keeps typechecking", async () => {
    const config = JSON.parse(await fs.readFile(canaryReleaseConfigPath, "utf8")) as ReleaseConfig;

    expect(config.hooks?.["before:init"]).not.toContain("bun run test");
    expect(config.hooks?.["before:init"]).toContain("bun run typecheck");
  });
});
