import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import {
  applianceFile,
  composeFile,
  factoryCredentialEnv,
  localInputsDigest,
  needsBaseRebuild,
  parseArgs,
  studioAddress,
} from "../scripts/local-up";

let root: string;

function write(relative: string, content: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe("the base image's input digest", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-local-inputs-"));
    write(
      "Dockerfile",
      [
        "FROM ${NODE_IMAGE} AS fetch",
        "COPY scripts/fetch-verified.sh /usr/local/bin/fetch-verified",
        "COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun",
        "COPY src/config.ts src/startup.ts /opt/mate/tools/startup/",
      ].join("\n"),
    );
    write("image-inputs.yaml", "mate:\n  version: 1.0.0\n");
    write("locks/global-tools.package-lock.json", "{}");
    write("locks/nested/graphify.requirements.txt", "a==1");
    write("scripts/fetch-verified.sh", "#!/bin/sh");
    write("src/config.ts", "export {};");
    write("src/startup.ts", "export {};");
    write("src/config.test.ts", "test");
    write("README.md", "readme");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test("is a stable sha256", () => {
    const digest = localInputsDigest(root);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(localInputsDigest(root)).toBe(digest);
  });

  test.each([
    "Dockerfile",
    "image-inputs.yaml",
    "locks/global-tools.package-lock.json",
    "locks/nested/graphify.requirements.txt",
    "scripts/fetch-verified.sh",
    "src/config.ts",
    "src/startup.ts",
  ])("changes when %s changes", (file) => {
    const before = localInputsDigest(root);
    fs.appendFileSync(path.join(root, file), "\n# changed");
    expect(localInputsDigest(root)).not.toBe(before);
  });

  test("changes when a lock file is added", () => {
    const before = localInputsDigest(root);
    write("locks/new.lock", "x");
    expect(localInputsDigest(root)).not.toBe(before);
  });

  test.each(["src/config.test.ts", "README.md"])(
    "ignores %s, which the recipe does not copy",
    (file) => {
      const before = localInputsDigest(root);
      fs.appendFileSync(path.join(root, file), "\nchanged");
      expect(localInputsDigest(root)).toBe(before);
    },
  );
});

describe("whether the base image is rebuilt", () => {
  test("a missing or unlabelled image is built", () => {
    expect(needsBaseRebuild({ imageLabel: null, digest: "abc", force: false })).toBe(true);
  });

  test("a matching image is reused", () => {
    expect(needsBaseRebuild({ imageLabel: "abc", digest: "abc", force: false })).toBe(false);
  });

  test("an image built from other inputs is rebuilt", () => {
    expect(needsBaseRebuild({ imageLabel: "old", digest: "abc", force: false })).toBe(true);
  });

  test("--rebuild-base rebuilds a matching image", () => {
    expect(needsBaseRebuild({ imageLabel: "abc", digest: "abc", force: true })).toBe(true);
  });
});

describe("the command line", () => {
  const home = "/home/dev";

  test("defaults to up, the mate-cli companion, and port 4098 beside the local appliance", () => {
    expect(parseArgs([], home)).toEqual({
      command: "up",
      companion: "/home/dev/.mate/companions/mate-cli-companion",
      rebuildBase: false,
      port: 4098,
    });
  });

  test.each(["up", "down", "reset", "logs"] as const)("accepts %s", (command) => {
    expect(parseArgs([command], home).command).toBe(command);
  });

  test("reads every option", () => {
    expect(
      parseArgs(["up", "--companion", "/tmp/acme", "--rebuild-base", "--port", "4100"], home),
    ).toEqual({
      command: "up",
      companion: "/tmp/acme",
      rebuildBase: true,
      port: 4100,
    });
  });

  test("resolves a relative companion path and expands ~", () => {
    expect(parseArgs(["--companion", "~/c/acme"], home).companion).toBe("/home/dev/c/acme");
    expect(parseArgs(["--companion", "acme"], home).companion).toBe(path.resolve("acme"));
  });

  test.each([
    [["deploy"], /unknown command/],
    [["up", "down"], /one command/],
    [["--port"], /--port/],
    [["--port", "0"], /--port/],
    [["--port", "70000"], /--port/],
    [["--port", "abc"], /--port/],
    [["--companion"], /--companion/],
    [["--publish"], /unknown option/],
    [["--factory"], /unknown option/],
  ])("refuses %p", (argv, message) => {
    expect(() => parseArgs(argv as string[], home)).toThrow(message);
  });
});

describe("the generated configuration", () => {
  const options = { companion: "/Users/dev/.mate/companions/acme-companion", port: 4097 };

  test("publishes Studio on loopback only and serves a clone of the read-only source", () => {
    const compose = parse(composeFile(options));
    expect(compose.name).toBe("mate-factory-local");
    const mate = compose.services.mate;
    expect(mate.image).toBe("mate-factory:local");
    expect(mate.ports).toEqual(["127.0.0.1:4097:4097"]);
    expect(mate.volumes).toContain(
      "/Users/dev/.mate/companions/acme-companion:/seed/acme-companion:ro",
    );
    expect(mate.volumes).toContain("companions:/companions");
    expect(mate.volumes).toContain("mate-home:/home/mate");
    expect(mate.volumes).toContain("./appliance.yaml:/etc/mate/appliance.yaml:ro");
    expect(mate.environment).toMatchObject({
      MATE_COMPANION_REPOS: "file:///seed/acme-companion=acme-companion",
      MATE_COMPANION: "acme-companion",
      MATE_GIT_SYNC: "false",
      MATE_STUDIO_WRITABLE: "true",
      MATE_STUDIO_TERMINAL: "true",
    });
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "companions",
      "factory-docker",
      "factory-state",
      "factory-sysbox",
      "mate-home",
    ]);
  });

  test("mounts the source companion nowhere writable", () => {
    const volumes: string[] = parse(composeFile(options)).services.mate.volumes;
    for (const volume of volumes.filter((entry) => entry.startsWith(options.companion))) {
      expect(volume.endsWith(":ro")).toBe(true);
    }
  });

  test("lets Studio answer on another host port", () => {
    const mate = parse(composeFile({ ...options, port: 4100 })).services.mate;
    expect(mate.ports).toEqual(["127.0.0.1:4100:4097"]);
    expect(mate.environment.MATE_STUDIO_ALLOWED_HOSTS).toBe("localhost:4100,127.0.0.1:4100");
  });

  test("writes no credential value", () => {
    const secretKey = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|SSH|\.npmrc|\.netrc/i;
    const compose = parse(composeFile(options));
    // A credential's name only passes the shell's value through.
    for (const [key, value] of Object.entries(compose.services.mate.environment)) {
      if (secretKey.test(key)) expect(value).toBeNull();
    }
    expect(composeFile(options)).not.toMatch(/\.ssh|id_ed25519|id_rsa/);
    const appliance = parse(applianceFile()) ?? {};
    for (const key of Object.keys(appliance)) {
      expect(key).not.toMatch(/token|secret|password|credential/i);
    }
  });
});

describe("the printed Studio address", () => {
  const log = [
    "mate-appliance: studio on 0.0.0.0:4097",
    "http://localhost:4097/?token=abc_DEF-123",
  ].join("\n");

  test("is the token-bearing address Studio prints", () => {
    expect(studioAddress(log, 4097)).toBe("http://localhost:4097/?token=abc_DEF-123");
  });

  test("names the published host port", () => {
    expect(studioAddress(log, 4100)).toBe("http://localhost:4100/?token=abc_DEF-123");
  });

  test("is absent until Studio has printed it", () => {
    expect(studioAddress("mate-appliance: studio on 0.0.0.0:4097", 4097)).toBeNull();
  });
});

describe("factory mode locally", () => {
  const options = { companion: "/home/acme/companions/acme", port: 4097 };

  test("starts as root, privileged, with the three factory volumes", () => {
    const compose = parse(composeFile(options));
    const mate = compose.services.mate;
    expect(mate.user).toBe("0");
    expect(mate.privileged).toBe(true);
    // The image itself turns factory mode on.
    expect(mate.environment.MATE_FACTORY).toBeUndefined();
    expect(mate.volumes).toEqual(
      expect.arrayContaining([
        "factory-docker:/var/lib/docker",
        "factory-sysbox:/var/lib/sysbox",
        "factory-state:/var/lib/mate-factory",
      ]),
    );
    expect(Object.keys(compose.volumes)).toContain("factory-state");
  });

  test("passes a credential and the factory's Git author through from the shell without writing them", () => {
    const environment = parse(composeFile(options)).services.mate.environment;
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
    expect(environment.ANTHROPIC_API_KEY).toBeNull();
    expect(environment.MATE_FACTORY_GIT_NAME).toBeNull();
    expect(environment.MATE_FACTORY_GIT_EMAIL).toBeNull();
  });
});

describe("the factory credential for a local run", () => {
  const stored = (text: string) => () => text;

  test("the shell's own credential wins", () => {
    expect(
      factoryCredentialEnv(
        { ANTHROPIC_API_KEY: "acme-key" },
        stored("CLAUDE_CODE_OAUTH_TOKEN=acme-token\n"),
      ),
    ).toEqual({
      name: "ANTHROPIC_API_KEY",
      value: "acme-key",
      source: "shell",
    });
  });

  test("otherwise the one `mate factory setup` stored is used", () => {
    expect(factoryCredentialEnv({}, stored("CLAUDE_CODE_OAUTH_TOKEN=acme-token\n"))).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "acme-token",
      source: "file",
    });
  });

  test("none stored and none in the shell is null", () => {
    expect(factoryCredentialEnv({}, () => null)).toBeNull();
    expect(factoryCredentialEnv({}, stored("OTHER=x\n"))).toBeNull();
  });
});
