import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sync, verify, type EntryDeps } from "../scripts/image-pins";
import { CONTAINER_ROOT } from "./image-inputs";
import { IMAGE_LOCKS, RELEASE_PACKAGES, type NpmRunner } from "./image-pins";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-image-pins-entry-"));
  tempDirs.push(dir);
  return dir;
}

/** Tarball content follows the package manifest, so a changed tree packs differently. */
const fakeNpm: NpmRunner = (args, { cwd }) => {
  const { name, version, content } = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  );
  const dest = args[args.indexOf("--pack-destination") + 1]!;
  const file = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
  fs.writeFileSync(path.join(dest, file), content ?? `acme-${name}-${version}`);
  return { status: 0 };
};

function lockEntry(name: string, version: string) {
  const packageName = name.slice(name.indexOf("/") + 1);
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${packageName}-${version}.tgz`,
    integrity: "sha512-acme-old",
  };
}

function lock(rootDependencies: string[], pinned: string[], version: string): string {
  return `${JSON.stringify(
    {
      packages: {
        "": {
          dependencies: Object.fromEntries(rootDependencies.map((name) => [name, version])),
        },
        ...Object.fromEntries(
          pinned.map((name) => [`node_modules/${name}`, lockEntry(name, version)]),
        ),
      },
    },
    null,
    2,
  )}\n`;
}

/** A workspace at `version` whose image locks still pin `0.1.0`. */
function workspace(version: string, options: { pinPlugin?: boolean } = {}): string {
  const root = tempDir();
  for (const { name, dir } of RELEASE_PACKAGES) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({ name, version }));
  }
  const container = path.join(root, "apps", "mate-container");
  fs.mkdirSync(path.join(container, "locks"), { recursive: true });
  fs.copyFileSync(
    path.join(CONTAINER_ROOT, "image-inputs.yaml"),
    path.join(container, "image-inputs.yaml"),
  );

  const plugin = options.pinPlugin === false ? [] : ["@uniqbit/mate-opencode-plugin"];
  const pins = [
    {
      root: ["@uniqbit/mate"],
      pinned: ["@uniqbit/mate", "@uniqbit/mate-core", ...plugin],
    },
    { root: [], pinned: ["@uniqbit/mate-core", ...plugin] },
  ];
  IMAGE_LOCKS.forEach(({ manifest, lock: lockFile }, index) => {
    fs.writeFileSync(
      path.join(container, manifest),
      `${JSON.stringify({ dependencies: { "@uniqbit/mate": "0.1.0" } }, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(container, lockFile),
      lock(pins[index]!.root, pins[index]!.pinned, "0.1.0"),
    );
  });
  return root;
}

function deps() {
  const output = { stdout: "", stderr: "", staged: [] as string[] };
  const entryDeps: EntryDeps = {
    runNpm: fakeNpm,
    stage: (files) => {
      output.staged.push(...files);
      return 0;
    },
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
  };
  return { output, entryDeps };
}

function snapshot(root: string): Map<string, string> {
  const container = path.join(root, "apps", "mate-container");
  const files = [
    "image-inputs.yaml",
    ...IMAGE_LOCKS.flatMap(({ manifest, lock }) => [manifest, lock]),
  ];
  return new Map(files.map((file) => [file, fs.readFileSync(path.join(container, file), "utf8")]));
}

function integrityOf(content: string): string {
  return `sha512-${createHash("sha512").update(content).digest("base64")}`;
}

describe("image-pins sync then verify", () => {
  test("pins written at preparation verify at publication", async () => {
    const root = workspace("1.2.3");
    const prepared = deps();

    expect(await sync(["1.2.3", root], prepared.entryDeps)).toBe(0);
    expect(prepared.output.staged).toHaveLength(1 + IMAGE_LOCKS.length * 2);

    const packDir = tempDir();
    const published = deps();
    expect(await verify(["1.2.3", packDir, root], published.entryDeps)).toBe(0);
    expect(published.output.stderr).toBe("");
    expect(published.output.stdout.trimEnd().split("\n")).toEqual(
      RELEASE_PACKAGES.map(({ name }) => {
        const file = `${name.replace(/^@/, "").replace("/", "-")}-1.2.3.tgz`;
        return [name, integrityOf(`acme-${name}-1.2.3`), path.join(packDir, file)].join("\t");
      }),
    );
  });

  test("a tree changed after preparation fails verification naming the stale locks", async () => {
    const root = workspace("1.2.3");
    expect(await sync(["1.2.3", root], deps().entryDeps)).toBe(0);

    const core = path.join(root, "packages/mate-core/package.json");
    fs.writeFileSync(
      core,
      JSON.stringify({ name: "@uniqbit/mate-core", version: "1.2.3", content: "acme-changed" }),
    );
    const published = deps();

    expect(await verify(["1.2.3", tempDir(), root], published.entryDeps)).not.toBe(0);
    expect(published.output.stdout).toBe("");
    expect(published.output.stderr).toContain(
      `@uniqbit/mate-core@1.2.3 would publish as ${integrityOf("acme-changed")}, but global-tools.package-lock.json, local-workspace.package-lock.json pin another tarball`,
    );
  });

  test("sync refuses a release package no image lock pins and writes nothing", async () => {
    const root = workspace("1.2.3", { pinPlugin: false });
    const before = snapshot(root);
    const prepared = deps();

    expect(await sync(["1.2.3", root], prepared.entryDeps)).not.toBe(0);
    expect(prepared.output.stderr).toContain("@uniqbit/mate-opencode-plugin");
    expect(prepared.output.staged).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  test("verify refuses a release package no image lock pins", async () => {
    const root = workspace("1.2.3", { pinPlugin: false });
    const published = deps();

    expect(await verify(["1.2.3", tempDir(), root], published.entryDeps)).not.toBe(0);
    expect(published.output.stderr).toContain("no image lock pins @uniqbit/mate-opencode-plugin");
    expect(published.output.stdout).toBe("");
  });
});
