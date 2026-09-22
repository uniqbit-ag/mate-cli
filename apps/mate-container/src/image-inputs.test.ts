import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { DEFAULT_CONFIG_FILE } from "./config";

import {
  CONTAINER_ROOT,
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
    // The two packages the agent loads at session start. A bundle missing
    // either is rejected by preparation rather than installed around.
    expect(Object.keys(inputs.prebuilt_workspace.packages).sort()).toEqual([
      "@uniqbit/mate-opencode-plugin",
      "context-mode",
    ]);
  });

  test("pin the plugin to the same Mate version the image installs", () => {
    // All public Mate packages release in lockstep; a bundle built against a
    // different version would fail preparation inside the container instead.
    expect(inputs.prebuilt_workspace.packages["@uniqbit/mate-opencode-plugin"]).toBe(
      inputs.mate.version,
    );
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
      ...Object.entries(inputs.os_packages.packages).map(
        ([name, version]) => [`os_packages.${name}`, version] as [string, string],
      ),
      ...Object.entries(inputs.tools).map(
        ([name, tool]) => [`tools.${name}`, tool.version] as [string, string],
      ),
      ...Object.entries(inputs.prebuilt_workspace.packages).map(
        ([name, version]) => [`prebuilt_workspace.${name}`, version] as [string, string],
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

  test("the OpenCode installer is checked before it is run, and pins its version", () => {
    expect(inputs.opencode.installer_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inputs.opencode.version_argument).toContain("--version");
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

  test("the global tool lock pins the Mate and OpenSpec versions the inputs declare", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(CONTAINER_ROOT, inputs.locks.global_tools!.manifest), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@uniqbit/mate"]).toBe(inputs.mate.version);
    expect(manifest.dependencies["@fission-ai/openspec"]).toBe(inputs.tools.openspec!.version);
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
      mate: { image: string; user: string; ports: string[]; volumes: string[] };
    };
  };
  const service = compose.services.mate;

  test("runs as the identity the image creates", () => {
    expect(service.user).toBe(`${inputs.runtime.uid}:${inputs.runtime.gid}`);
  });

  test("publishes both ports the container serves on", () => {
    const published = service.ports.map((entry) => entry.split(":").at(-1));
    expect(published).toEqual(["4096", "4097"]);
    // Bound to loopback, because neither port authenticates anything.
    expect(service.ports.every((entry) => entry.startsWith("127.0.0.1:"))).toBe(true);
  });

  test("mounts the companions directory and the configuration file", () => {
    const mounted = service.volumes.map((entry) => entry.split(":")[1]);
    expect(mounted).toContain(inputs.runtime.companions_dir);
    expect(mounted).toContain(DEFAULT_CONFIG_FILE);
  });
});
