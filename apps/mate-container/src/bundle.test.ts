import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";

const BUNDLE = path.join(import.meta.dir, "..", "..", "..", "docs", "deployments", "acme");
const read = (name: string) => fs.readFileSync(path.join(BUNDLE, name), "utf8");
const compose = () => parse(read("compose.yaml")) as Record<string, any>;

describe("the reference bundle's shared files", () => {
  test("both services run one exact image tag with no build step", () => {
    const { services } = compose();
    expect(services.setup.image).toBe(services.mate.image);
    expect(services.setup.image).toMatch(
      /mate-appliance:\$\{MATE_IMAGE_TAG:-\d+\.\d+\.\d+[^}]*\}$/,
    );
    expect(services.setup.image).not.toMatch(/canary\}|:latest|:canary$/);
    expect(services.setup.build).toBeUndefined();
    expect(services.mate.build).toBeUndefined();
  });

  test("setup is a profile the appliance never depends on", () => {
    const { services } = compose();
    expect(services.setup.profiles).toEqual(["setup"]);
    expect(services.mate.profiles).toBeUndefined();
    expect(services.mate.depends_on).toBeUndefined();
  });

  test("the appliance receives no setup-only token", () => {
    const { services } = compose();
    expect(JSON.stringify(services.mate)).not.toMatch(/GITLAB_TOKEN|NPM_CONFIG/);
    expect(services.setup.environment.GITLAB_TOKEN).toContain("GITLAB_TOKEN");
  });

  test("the personal config is mounted into both services and must exist", () => {
    const { services } = compose();
    for (const service of [services.setup, services.mate]) {
      const mount = service.volumes.find((v: any) => v.target === "/etc/mate/appliance.yaml");
      expect(mount).toMatchObject({ read_only: true, bind: { create_host_path: false } });
    }
  });

  test("both services see the same allowlist override", () => {
    const { services } = compose();
    expect("MATE_ALLOWED_PLUGINS" in services.setup.environment).toBe(true);
    expect("MATE_ALLOWED_PLUGINS" in services.mate.environment).toBe(true);
  });

  test("setup runs the mounted script through a named shell", () => {
    const { services } = compose();
    expect(services.setup.entrypoint).toEqual(["bash", "/usr/local/bin/setup.sh"]);
  });

  test("a bare start explains how to run setup", () => {
    expect(compose().services.mate.environment.MATE_SETUP_HINT).toContain(
      "docker compose run --rm setup",
    );
  });

  test("the named-volume override swaps the storage of both services", () => {
    const override = parse(read("compose.volume.yaml")) as Record<string, any>;
    expect(override.services.setup.volumes).toEqual(["companions:/companions"]);
    expect(override.services.mate.volumes).toEqual(["companions:/companions"]);
    expect(override.volumes).toHaveProperty("companions");
  });

  test("no shared file holds a token, and npm expands it at use time", () => {
    for (const file of [
      "compose.yaml",
      "compose.volume.yaml",
      ".npmrc",
      "setup.sh",
      "README.md",
      ".env.example",
      "appliance.example.yaml",
    ]) {
      expect(read(file)).not.toMatch(/glpat-|_authToken=[A-Za-z0-9]/);
    }
    expect(read(".npmrc")).toContain("_authToken=${GITLAB_TOKEN}");
    expect(read(".npmrc")).toMatch(/^@acme:registry=/m);
  });

  test("personal files and checkouts are ignored; scripts keep LF", () => {
    expect(read(".gitignore").split("\n")).toEqual(
      expect.arrayContaining([".env", "appliance.yaml", "companions/"]),
    );
    expect(read(".gitattributes")).toContain("*.sh text eol=lf");
  });

  test("the setup script is valid bash", () => {
    const result = spawnSync("bash", ["-n", path.join(BUNDLE, "setup.sh")], { encoding: "utf8" });
    expect(result.stderr).toBe("");
  });
});

describe("setup.sh", () => {
  let root: string;
  let calls: string;

  const script = path.join(BUNDLE, "setup.sh");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-bundle-"));
    calls = path.join(root, "calls.log");
    fs.mkdirSync(path.join(root, "bin"));
    fs.mkdirSync(path.join(root, "companions"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function stub(name: string, body: string): void {
    const file = path.join(root, "bin", name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }

  function stubs(options: { installStatus?: number } = {}): void {
    stub(
      "bun",
      `echo "export MATE_ALLOWED_PLUGINS='@acme/reader'"; echo "export ACME_READ_TOKEN='cred'"`,
    );
    stub(
      "git",
      `echo "git $*" >> "${calls}"
dest="\${@: -1}"; mkdir -p "$dest/.git"`,
    );
    stub(
      "mate",
      `echo "mate $* | allowed=$MATE_ALLOWED_PLUGINS cred=$ACME_READ_TOKEN" >> "${calls}"
[[ "$1 $2" == "install --yes" ]] && exit ${options.installStatus ?? 0}
exit 0`,
    );
  }

  function run(env: Record<string, string> = {}) {
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
        HOME: root,
        MATE_COMPANIONS_DIR: path.join(root, "companions"),
        GITLAB_TOKEN: "tok-secret",
        COMPANION_REPO: "https://git.example.test/acme/acme-companion.git",
        COMPANION_DIR: "acme-companion",
        ...env,
      },
    });
  }

  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "");

  test("clones without persisting the token, then registers and restores frozen", () => {
    stubs();
    const result = run();
    expect(result.status).toBe(0);
    const lines = log().trim().split("\n");
    expect(lines[0]).toStartWith("git -c credential.helper=");
    expect(lines[0]).toContain("clone https://git.example.test/acme/acme-companion.git");
    expect(log()).not.toContain("tok-secret");
    expect(lines[1]).toContain("mate companion register");
    expect(lines[2]).toContain("mate install --yes --frozen-plugins");
  });

  test("the effective policy and credentials reach Mate before it runs", () => {
    stubs();
    run();
    expect(log()).toContain("allowed=@acme/reader cred=cred");
  });

  test("an existing checkout is neither re-cloned nor reset", () => {
    stubs();
    fs.mkdirSync(path.join(root, "companions", "acme-companion", ".git"), { recursive: true });
    expect(run().status).toBe(0);
    expect(log()).not.toContain("git ");
  });

  test("a failed install fails setup", () => {
    stubs({ installStatus: 1 });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mate install failed");
  });

  test("a project-local npmrc is refused before any install", () => {
    stubs();
    const dir = path.join(root, "companions", "acme-companion");
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".mate", "plugins"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".mate", "plugins", ".npmrc"), "registry=https://x.test/");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".npmrc");
    expect(log()).not.toContain("mate install");
  });

  test("a missing setup token stops before anything runs", () => {
    stubs();
    const result = run({ GITLAB_TOKEN: "" });
    expect(result.status).toBe(1);
    expect(log()).toBe("");
  });

  test("an unwritable companions directory is named", () => {
    stubs();
    const result = run({ MATE_COMPANIONS_DIR: path.join(root, "absent") });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.join(root, "absent"));
  });
});
