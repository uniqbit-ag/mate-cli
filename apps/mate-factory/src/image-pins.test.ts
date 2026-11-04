import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  IMAGE_LOCKS,
  packRelease,
  RELEASE_PACKAGES,
  stalePins,
  unpinned,
  type NpmRunner,
  type PackedTarball,
} from "./image-pins";

const GLOBAL_LOCK = IMAGE_LOCKS[0].lock;
const WORKSPACE_LOCK = IMAGE_LOCKS[1].lock;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acme-image-pins-"));
  tempDirs.push(dir);
  return dir;
}

function integrityOf(content: string): string {
  return `sha512-${createHash("sha512").update(content).digest("base64")}`;
}

function lockSource(entries: Record<string, { version: string; integrity: string }>): string {
  return JSON.stringify({
    packages: Object.fromEntries(
      Object.entries(entries).map(([name, entry]) => [`node_modules/${name}`, entry]),
    ),
  });
}

function packed(entries: Record<string, string>): Map<string, PackedTarball> {
  return new Map(
    Object.entries(entries).map(([name, integrity]) => [
      name,
      { tarball: `/acme/${name}.tgz`, integrity },
    ]),
  );
}

describe("stale image pins", () => {
  const good = integrityOf("acme-core");

  test("a lock pinning the packed version and integrity is not stale", () => {
    const locks = new Map([
      [GLOBAL_LOCK, lockSource({ "@uniqbit/mate-core": { version: "1.2.3", integrity: good } })],
    ]);

    expect(stalePins(locks, "1.2.3", packed({ "@uniqbit/mate-core": good }))).toEqual([]);
  });

  test("a lock pinning another version is stale", () => {
    const locks = new Map([
      [GLOBAL_LOCK, lockSource({ "@uniqbit/mate-core": { version: "1.2.2", integrity: good } })],
    ]);

    expect(stalePins(locks, "1.2.3", packed({ "@uniqbit/mate-core": good }))).toEqual([
      { name: "@uniqbit/mate-core", integrity: good, staleLocks: [GLOBAL_LOCK] },
    ]);
  });

  test("a lock pinning another integrity is stale, naming every such lock", () => {
    const other = integrityOf("acme-other");
    const locks = new Map([
      [GLOBAL_LOCK, lockSource({ "@uniqbit/mate-core": { version: "1.2.3", integrity: other } })],
      [
        WORKSPACE_LOCK,
        lockSource({ "@uniqbit/mate-core": { version: "1.2.3", integrity: other } }),
      ],
    ]);

    expect(stalePins(locks, "1.2.3", packed({ "@uniqbit/mate-core": good }))).toEqual([
      { name: "@uniqbit/mate-core", integrity: good, staleLocks: [GLOBAL_LOCK, WORKSPACE_LOCK] },
    ]);
  });

  test("a lock that is not an image lock is ignored", () => {
    const locks = new Map([
      [GLOBAL_LOCK, lockSource({ "@uniqbit/mate-core": { version: "1.2.3", integrity: good } })],
      [
        "locks/acme.package-lock.json",
        lockSource({ "@uniqbit/mate-core": { version: "0.0.1", integrity: "sha512-acme" } }),
      ],
    ]);

    expect(stalePins(locks, "1.2.3", packed({ "@uniqbit/mate-core": good }))).toEqual([]);
  });
});

describe("unpinned release packages", () => {
  const pin = { version: "1.2.3", integrity: "sha512-acme" };

  test("a package pinned by at least one image lock is pinned", () => {
    const locks = new Map([
      [GLOBAL_LOCK, lockSource({ "@uniqbit/mate": pin })],
      [WORKSPACE_LOCK, lockSource({ "@uniqbit/mate-core": pin })],
    ]);

    expect(unpinned(locks, ["@uniqbit/mate", "@uniqbit/mate-core"])).toEqual([]);
  });

  test("a package no image lock pins is named", () => {
    const locks = new Map([[GLOBAL_LOCK, lockSource({ "@uniqbit/mate": pin })]]);

    expect(unpinned(locks, ["@uniqbit/mate", "@uniqbit/mate-core"])).toEqual([
      "@uniqbit/mate-core",
    ]);
  });

  test("a pin in a lock that is not an image lock does not count", () => {
    const locks = new Map([["locks/acme.package-lock.json", lockSource({ "@uniqbit/mate": pin })]]);

    expect(unpinned(locks, ["@uniqbit/mate"])).toEqual(["@uniqbit/mate"]);
  });
});

describe("packing the release packages", () => {
  type Call = { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv };

  /** Writes the tarball npm would, named from the package directory's manifest. */
  function fakeNpm(calls: Call[], options: { skip?: string; failFor?: string } = {}): NpmRunner {
    return (args, { cwd, env }) => {
      calls.push({ args, cwd, env });
      const { name, version } = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
      if (name === options.failFor) return { status: 1 };
      if (name !== options.skip) {
        const dest = args[args.indexOf("--pack-destination") + 1]!;
        const file = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
        fs.writeFileSync(path.join(dest, file), `acme-${name}`);
      }
      return { status: 0 };
    };
  }

  function workspace(version: string): string {
    const root = tempDir();
    for (const { name, dir } of RELEASE_PACKAGES) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, "package.json"), JSON.stringify({ name, version }));
    }
    return root;
  }

  test("packs every release package in publish order with the scoped tarball name", () => {
    const root = workspace("1.2.3");
    const dest = tempDir();

    const result = packRelease("1.2.3", root, dest, { runNpm: fakeNpm([]) });

    expect([...result.keys()]).toEqual(RELEASE_PACKAGES.map(({ name }) => name));
    expect(result.get("@uniqbit/mate-core")!.tarball).toBe(
      path.join(dest, "uniqbit-mate-core-1.2.3.tgz"),
    );
    expect(result.get("@uniqbit/mate")!.tarball).toBe(path.join(dest, "uniqbit-mate-1.2.3.tgz"));
  });

  test("reports the base64 sha512 integrity of each tarball", () => {
    const root = workspace("1.2.3");

    const result = packRelease("1.2.3", root, tempDir(), { runNpm: fakeNpm([]) });

    for (const { name } of RELEASE_PACKAGES) {
      expect(result.get(name)!.integrity).toBe(integrityOf(`acme-${name}`));
    }
  });

  test("packs from each package directory, in CI mode, quietly, into the destination", () => {
    const root = workspace("1.2.3");
    const dest = tempDir();
    const calls: Call[] = [];

    packRelease("1.2.3", root, dest, { runNpm: fakeNpm(calls) });

    expect(calls.map(({ cwd }) => cwd)).toEqual(
      RELEASE_PACKAGES.map(({ dir }) => path.join(root, dir)),
    );
    for (const call of calls) {
      expect(call.args).toEqual(["pack", "--pack-destination", dest, "--loglevel", "error"]);
      expect(call.env.CI).toBe("1");
    }
  });

  test("fails naming the tarball npm did not create", () => {
    const root = workspace("1.2.3");

    expect(() =>
      packRelease("1.2.3", root, tempDir(), {
        runNpm: fakeNpm([], { skip: "@uniqbit/mate-core" }),
      }),
    ).toThrow("uniqbit-mate-core-1.2.3.tgz");
  });

  test("fails naming the package npm could not pack", () => {
    const root = workspace("1.2.3");

    expect(() =>
      packRelease("1.2.3", root, tempDir(), { runNpm: fakeNpm([], { failFor: "@uniqbit/mate" }) }),
    ).toThrow("packing @uniqbit/mate failed");
  });
});
