import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import { DEFAULT_CONFIG_FILE } from "./config";

import {
  CONTAINER_ROOT,
  globalToolsLockDrift,
  isMovingReference,
  readImageInputs,
  REQUIRED_TOOL_COMMANDS,
} from "./image-inputs";

const inputs = readImageInputs();

describe("release-owned image inputs", () => {
  test("declare both supported targets", () => {
    expect(inputs.targets.map((target) => `${target.platform}/${target.arch}`).sort()).toEqual([
      "linux/amd64",
      "linux/arm64",
    ]);
  });

  test("cover every command the installation gate can require", () => {
    const covered = Object.values(inputs.tools).map((tool) => tool.detect);
    for (const command of REQUIRED_TOOL_COMMANDS) {
      expect(covered).toContain(command);
    }
  });

  test("carry every distribution-owned runtime package in the prebuilt workspace", () => {
    /** The Mate OpenCode plugin ships inside mate-core, so context-mode is the only one. */
    expect(Object.keys(inputs.prebuilt_workspace.packages).sort()).toEqual(["context-mode"]);
  });

  test("install a Mate version at or above the recorded minimum", () => {
    expect(Bun.semver.order(inputs.mate.version, inputs.mate.minimum_compatible)).toBeGreaterThan(
      -1,
    );
  });
});

describe("no moving references", () => {
  test("base images are referenced by immutable digest", () => {
    for (const [name, image] of Object.entries(inputs.base_images)) {
      expect(image.digest, `${name} digest`).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("every pinned version is exact", () => {
    const versions: Array<[string, string]> = [
      ["mate.version", inputs.mate.version],
      ["mate.minimum_compatible", inputs.mate.minimum_compatible],
      ["opencode.version", inputs.opencode.version],
      ["claude.version", inputs.claude.version],
      ...Object.entries(inputs.os_packages.packages).map(
        ([name, version]) => [`os_packages.${name}`, version] as [string, string],
      ),
      ...Object.entries(inputs.tools).map(
        ([name, tool]) => [`tools.${name}`, tool.version] as [string, string],
      ),
      ...Object.entries(inputs.prebuilt_workspace.packages).map(
        ([name, version]) => [`prebuilt_workspace.${name}`, version] as [string, string],
      ),
      ["factory.sysbox", inputs.factory.sysbox.version],
      ...Object.entries(inputs.factory.docker_engine.packages).map(
        ([name, pkg]) => [`factory.docker_engine.${name}`, pkg.version] as [string, string],
      ),
      ...Object.entries(inputs.factory.os_packages).map(
        ([name, version]) => [`factory.os_packages.${name}`, version] as [string, string],
      ),
    ];
    for (const [where, version] of versions) {
      expect(isMovingReference(version), `${where} is "${version}"`).toBe(false);
    }
  });

  test("every downloaded artifact is checked, for every target", () => {
    const archs = inputs.targets.map((target) => target.arch);
    const downloads: Array<[string, Record<string, { file: string; sha256: string }>]> = [
      ["opencode", inputs.opencode.artifacts],
      ["claude", inputs.claude.artifacts],
      ["sysbox", inputs.factory.sysbox.artifacts],
      ...Object.entries(inputs.factory.docker_engine.packages).map(
        ([name, pkg]) => [name, pkg.artifacts] as [string, Record<string, never>],
      ),
      ...Object.entries(inputs.tools)
        .filter(([, tool]) => tool.artifacts !== undefined)
        .map(([name, tool]) => [name, tool.artifacts!] as [string, Record<string, never>]),
    ];
    for (const [name, artifacts] of downloads) {
      for (const arch of archs) {
        const artifact = artifacts[arch];
        expect(artifact, `${name} has no ${arch} artifact`).toBeDefined();
        expect(artifact!.sha256, `${name}/${arch} sha256`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test("OpenCode is the exact version's npm platform tarball, at a major Mate supports", () => {
    expect(Number(inputs.opencode.version.split(".")[0])).toBeGreaterThanOrEqual(2);
    for (const artifact of Object.values(inputs.opencode.artifacts)) {
      expect(artifact.file).toEndWith(`-${inputs.opencode.version}.tgz`);
    }
  });

  test("Debian versions are exact while npm ranges stay moving", () => {
    for (const exact of ["5:29.9.2-1~debian.13~trixie", "2.4.2-3~debian.13~trixie", "3.17.2-3"]) {
      expect(isMovingReference(exact), exact).toBe(false);
    }
    for (const moving of ["~1.2.3", "^1.2.3", "1.2.x", ">=1.2.3", "latest"]) {
      expect(isMovingReference(moving), moving).toBe(true);
    }
  });

  test("factory downloads are named as the Dockerfile derives them from the version", () => {
    const { sysbox, docker_engine: engine } = inputs.factory;
    for (const [arch, artifact] of Object.entries(sysbox.artifacts)) {
      expect(artifact.file).toBe(
        `v${sysbox.version}/sysbox-ce_${sysbox.version}.linux_${arch}.deb`,
      );
    }
    for (const [name, pkg] of Object.entries(engine.packages)) {
      const debVersion = pkg.version.replace(/^\d+:/, "");
      for (const [arch, artifact] of Object.entries(pkg.artifacts)) {
        expect(artifact.file).toBe(`${arch}/${name}_${debVersion}_${arch}.deb`);
      }
    }
  });

  test("a tool with no checked artifact resolves through a lockfile instead", () => {
    for (const [name, tool] of Object.entries(inputs.tools)) {
      if (tool.artifacts !== undefined) continue;
      expect(
        ["base_image", "npm_global", "uv_tool"],
        `${name} has neither artifacts nor a locked source`,
      ).toContain(tool.source);
    }
  });
});

describe("dependency locks", () => {
  const lockPaths = Object.values(inputs.locks);

  test("every declared lock file exists", () => {
    for (const lock of lockPaths) {
      expect(fs.existsSync(path.join(CONTAINER_ROOT, lock.manifest)), lock.manifest).toBe(true);
      expect(fs.existsSync(path.join(CONTAINER_ROOT, lock.lockfile)), lock.lockfile).toBe(true);
    }
  });

  test("direct dependencies are exact, so a rebuild cannot resolve a newer graph", () => {
    for (const lock of lockPaths) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(CONTAINER_ROOT, lock.manifest), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
        expect(isMovingReference(range), `${lock.manifest}: ${name}@${range}`).toBe(false);
      }
    }
  });

  test("every resolved package in a lock carries an integrity digest", () => {
    for (const lock of lockPaths) {
      const lockfile = JSON.parse(
        fs.readFileSync(path.join(CONTAINER_ROOT, lock.lockfile), "utf8"),
      ) as { packages: Record<string, { resolved?: string; integrity?: string; link?: boolean }> };
      const entries = Object.entries(lockfile.packages).filter(
        ([location, entry]) => location !== "" && entry.link !== true,
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [location, entry] of entries) {
        expect(entry.resolved, `${lock.lockfile}: ${location} has no resolved URL`).toBeDefined();
        expect(entry.integrity, `${lock.lockfile}: ${location} has no integrity`).toMatch(
          /^sha(256|512)-/,
        );
      }
    }
  });

  test("the global tool lock pins the Mate, OpenSpec and Context7 versions the inputs declare", () => {
    expect(globalToolsLockDrift(inputs, CONTAINER_ROOT)).toEqual([]);
  });

  test("the graphify lock and its input name the manifest's graphify version", () => {
    const pin = `graphifyy==${inputs.tools.graphify!.version}`;
    for (const file of ["graphify.in", "graphify.requirements.txt"]) {
      const text = fs.readFileSync(path.join(CONTAINER_ROOT, "locks", file), "utf8");
      expect(text.match(/^graphifyy==\S+/m)?.[0], file).toBe(pin);
    }
  });

  test("the local workspace lock declares exactly the distribution-owned packages", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CONTAINER_ROOT, inputs.locks.local_workspace!.manifest), "utf8"),
    ) as { dependencies: Record<string, string> };
    // Preparation refuses a bundle that declares anything else, or any version
    // other than the distribution's own pin.
    expect(manifest.dependencies).toEqual(inputs.prebuilt_workspace.packages);
  });
});

describe("the compose example matches the image", () => {
  const compose = parse(
    fs.readFileSync(path.join(CONTAINER_ROOT, "compose.example.yaml"), "utf8"),
  ) as {
    services: {
      mate: {
        image: string;
        user?: string;
        privileged: boolean;
        ports: string[];
        volumes: string[];
        environment: Record<string, string>;
      };
    };
  };
  const service = compose.services.mate;

  test("runs the factory image privileged, starting as the root the image names", () => {
    expect(service.image).toContain("/mate-factory:");
    expect(service.user).toBeUndefined();
    expect(service.privileged).toBe(true);
  });

  test("publishes Studio alone, on loopback", () => {
    const published = service.ports.map((entry) => entry.split(":").at(-1));
    expect(published).toEqual(["4097"]);
    expect(service.ports.every((entry) => entry.startsWith("127.0.0.1:"))).toBe(true);
  });

  test("keeps the factory's state on its three volumes", () => {
    const mounted = service.volumes.map((entry) => entry.split(":")[1]);
    for (const target of ["/var/lib/docker", "/var/lib/sysbox", "/var/lib/mate-factory"]) {
      expect(mounted).toContain(target);
    }
  });

  test("shows the factory's own settings, naming no credential value", () => {
    const raw = fs.readFileSync(path.join(CONTAINER_ROOT, "compose.example.yaml"), "utf8");
    for (const name of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "MATE_FACTORY_REPOSITORIES",
      "MATE_FACTORY_GIT_NAME",
      "MATE_FACTORY_GIT_EMAIL",
    ]) {
      expect(raw).toContain(name);
    }
    expect(Object.keys(service.environment)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("mounts the companions directory and the configuration file", () => {
    const mounted = service.volumes.map((entry) => entry.split(":")[1]);
    expect(mounted).toContain(inputs.runtime.companions_dir);
    expect(mounted).toContain(DEFAULT_CONFIG_FILE);
  });
});

describe("shared tools from mate-core's tool manifest", () => {
  const rtk = "  rtk: { detect: rtk, version: 1.1.0, source: github_release }\n";
  let root: string;

  function read(imageExtra = "", manifestExtra = "") {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-image-inputs-"));
    fs.writeFileSync(
      path.join(root, "image-inputs.yaml"),
      `schema: 1
mate: { version: 0.20.0 }
tools:
  bun: { detect: bun, version: 1.4.2, source: base_image }
${imageExtra}locks:
  global_tools: { manifest: global-tools.package.json, lockfile: unused.json }
`,
    );
    fs.writeFileSync(
      path.join(root, "tool-manifest.yaml"),
      `schema: 1
tools:
  openspec: { detect: openspec, package: "@fission-ai/openspec", version: 1.16.0, source: npm_global }
  context7: { detect: context7-mcp, package: "@upstash/context7-mcp", version: 4.2.0, source: npm_global }
  skills: { detect: skills, package: skills, version: 1.7.6, source: npm_dependency }
  tokensave:
    detect: tokensave
    version: 7.16.0
    source: github_release
    artifacts:
      amd64: { file: tokensave-v7.16.0-x86_64-linux.tar.gz, sha256: ${"a".repeat(64)} }
${manifestExtra}`,
    );
    fs.writeFileSync(
      path.join(root, "global-tools.package.json"),
      JSON.stringify({
        dependencies: {
          "@uniqbit/mate": "0.20.0",
          "@fission-ai/openspec": "1.15.0",
          "@upstash/context7-mcp": "4.2.0",
        },
      }),
    );
    return readImageInputs(
      path.join(root, "image-inputs.yaml"),
      path.join(root, "tool-manifest.yaml"),
    );
  }

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("a tool listed in both files is rejected", () => {
    expect(() => read(rtk, rtk)).toThrow("rtk is listed in both");
  });

  test("a manifest bump the npm lock missed fails the lock check", () => {
    expect(globalToolsLockDrift(read(), root)).toEqual([
      "@fission-ai/openspec: lock 1.15.0, inputs 1.16.0",
    ]);
  });

  test("a manifest download reaches the image tools with its digest; npm dependencies do not", () => {
    const merged = read();
    expect(merged.tools.tokensave!.version).toBe("7.16.0");
    expect(merged.tools.tokensave!.artifacts!.amd64!.sha256).toBe("a".repeat(64));
    expect(merged.tools.skills).toBeUndefined();
  });
});
