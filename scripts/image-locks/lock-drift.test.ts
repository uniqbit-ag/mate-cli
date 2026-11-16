import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { check, refresh, type Io } from "./cli";
import {
  checkImageLocks,
  refreshImageLocks,
  spawnNpm,
  type Deps,
  type NpmRunner,
} from "./lock-drift";

const CONTAINER_LOCK = "apps/mate-container/locks/global-tools.package-lock.json";
const FACTORY_LOCK = "apps/mate-factory/locks/global-tools.package-lock.json";
const REGISTRY = "https://registry.npmjs.org";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Entry = Record<string, unknown>;
type Lock = { packages: Record<string, Entry> };

function pinned(name: string, version: string, extra: Entry = {}): Entry {
  const base = name.slice(name.indexOf("/") + 1);
  return {
    version,
    resolved: `${REGISTRY}/${name}/-/${base}-${version}.tgz`,
    integrity: `sha512-acme-${base}-${version}`,
    ...extra,
  };
}

/** A lock for one global tool: the CLI pins the core, and both use `acme-dep`. */
function lockFixture(options: { coreDependencies?: Record<string, string> } = {}): Lock {
  const coreDependencies = options.coreDependencies ?? { "acme-dep": "^1.0.0" };
  return {
    packages: {
      "": { name: "acme-tools", version: "0.0.0", dependencies: { "@uniqbit/mate": "1.0.0" } },
      "node_modules/@uniqbit/mate": pinned("@uniqbit/mate", "1.0.0", {
        dependencies: { "@uniqbit/mate-core": "1.0.0", "acme-dep": "^1.0.0" },
      }),
      "node_modules/@uniqbit/mate-core": pinned("@uniqbit/mate-core", "1.0.0", {
        dependencies: coreDependencies,
      }),
      "node_modules/acme-dep": pinned("acme-dep", "1.2.0"),
    },
  };
}

function write(file: string, contents: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

/** The release packages are one version ahead of the locks, as they are before publication. */
function workspace(
  options: {
    coreDependencies?: Record<string, string>;
    containerLock?: Lock;
    factoryLock?: Lock;
  } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acme-image-locks-"));
  tempDirs.push(root);
  write(path.join(root, "packages/mate-core/package.json"), {
    name: "@uniqbit/mate-core",
    version: "2.0.0",
    dependencies: options.coreDependencies ?? { "acme-dep": "^1.0.0" },
  });
  write(path.join(root, "apps/mate-cli/package.json"), {
    name: "@uniqbit/mate",
    version: "2.0.0",
    dependencies: { "@uniqbit/mate-core": "2.0.0", "acme-dep": "^1.0.0" },
  });
  for (const [image, lock] of [
    ["apps/mate-container", options.containerLock ?? lockFixture()],
    ["apps/mate-factory", options.factoryLock ?? lockFixture()],
  ] as const) {
    write(path.join(root, image, "locks/global-tools.package.json"), {
      name: "acme-tools",
      version: "0.0.0",
      dependencies: { "@uniqbit/mate": "1.0.0" },
    });
    write(path.join(root, image, "locks/global-tools.package-lock.json"), lock);
  }
  return root;
}

function readLock(root: string, lock: string): Lock {
  return JSON.parse(fs.readFileSync(path.join(root, lock), "utf8")) as Lock;
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(
    [CONTAINER_LOCK, FACTORY_LOCK].map((lock) => [
      lock,
      fs.readFileSync(path.join(root, lock), "utf8"),
    ]),
  );
}

type Resolve = (lock: Lock, install: number) => void;

/** Answers `npm install` from a script, and everything else with the real npm. */
function scriptedNpm(resolve: Resolve, calls: string[][] = []): NpmRunner {
  let installs = 0;
  return (args, options) => {
    calls.push([...args]);
    if (args[0] !== "install") return spawnNpm(args, options);
    const file = path.join(options.cwd, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(file, "utf8")) as Lock;
    resolve(lock, installs++);
    fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
    return { status: 0, stdout: "", stderr: "" };
  };
}

function deps(runNpm: NpmRunner, overrides: Partial<Deps> = {}): Deps {
  return {
    runNpm,
    format: (source) => source,
    writeFile: (file, contents) => fs.writeFileSync(file, contents),
    rename: (from, to) => fs.renameSync(from, to),
    ...overrides,
  };
}

/** Adds `acme-new` the way npm resolves a dependency the lock does not have yet. */
const addsNewDependency: Resolve = (lock) => {
  lock.packages["node_modules/acme-new"] = pinned("acme-new", "3.1.0");
};

const addsNew = { "acme-dep": "^1.0.0", "acme-new": "^3.0.0" };

function captureIo(): Io & { out: string; err: string } {
  const io = {
    out: "",
    err: "",
    stdout: (text: string) => void (io.out += text),
    stderr: (text: string) => void (io.err += text),
  };
  return io;
}

describe("checkImageLocks", () => {
  test("accepts locks whose release metadata and graph match, whatever the release version", () => {
    const root = workspace();

    const results = checkImageLocks(root, { runNpm: spawnNpm });

    expect(results).toEqual([
      { lock: CONTAINER_LOCK, problems: [] },
      { lock: FACTORY_LOCK, problems: [] },
    ]);
  });

  test("names the dependency, package and both locks when core gains a dependency", () => {
    const root = workspace({ coreDependencies: addsNew });

    const results = checkImageLocks(root, { runNpm: spawnNpm });

    for (const result of results) {
      expect(result.problems).toEqual([
        '@uniqbit/mate-core dependencies: the lock lacks "acme-new@^3.0.0"',
      ]);
    }
    expect(results.map(({ lock }) => lock)).toEqual([CONTAINER_LOCK, FACTORY_LOCK]);
  });

  test("identifies the factory lock when only it drifts", () => {
    const stale = lockFixture({ coreDependencies: { "acme-dep": "^1.0.0", "acme-old": "^1.0.0" } });
    stale.packages["node_modules/acme-old"] = pinned("acme-old", "1.0.0");
    const root = workspace({ factoryLock: stale });

    const [container, factory] = checkImageLocks(root, { runNpm: spawnNpm });

    expect(container!.problems).toEqual([]);
    expect(factory).toEqual({
      lock: FACTORY_LOCK,
      problems: [
        '@uniqbit/mate-core dependencies: the lock still has "acme-old@^1.0.0", which the release package dropped',
      ],
    });
  });

  test("reports a changed range and a missing release entry", () => {
    const changed = lockFixture({ coreDependencies: { "acme-dep": "^0.9.0" } });
    const missing = lockFixture();
    delete missing.packages["node_modules/@uniqbit/mate-core"];
    const root = workspace({ containerLock: changed, factoryLock: missing });

    const [container, factory] = checkImageLocks(root, { runNpm: spawnNpm });

    expect(container!.problems).toContain(
      '@uniqbit/mate-core dependencies: "acme-dep" is ^0.9.0 in the lock but ^1.0.0 in the release package',
    );
    expect(factory!.problems).toContain("@uniqbit/mate-core has no entry in the lock");
  });

  test("rejects a declared dependency whose pinned installation is absent", () => {
    const lock = lockFixture({ coreDependencies: addsNew });
    const root = workspace({ coreDependencies: addsNew, containerLock: lock });

    const [container, factory] = checkImageLocks(root, { runNpm: spawnNpm });

    expect(container!.problems).toEqual([
      expect.stringContaining("missing: acme-new@^3.0.0, required by @uniqbit/mate-core@1.0.0"),
    ]);
    expect(factory!.problems).toEqual([
      '@uniqbit/mate-core dependencies: the lock lacks "acme-new@^3.0.0"',
    ]);
  });

  test("only reads the committed pins: it never installs, resolves or edits a lock", () => {
    const root = workspace({ coreDependencies: addsNew });
    const before = snapshot(root);
    const calls: string[][] = [];

    checkImageLocks(root, { runNpm: scriptedNpm(addsNewDependency, calls) });

    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.slice(0, 1)).toEqual(["ls"]);
      expect(call).toContain("--offline");
      expect(call).toContain("--package-lock-only");
    }
    expect(snapshot(root)).toEqual(before);
  });
});

describe("check command", () => {
  test("fails with a refresh instruction when a lock drifted", () => {
    const root = workspace({ coreDependencies: addsNew });
    const io = captureIo();

    const status = check(root, { runNpm: spawnNpm }, io);

    expect(status).toBe(1);
    expect(io.err).toContain(`${CONTAINER_LOCK} is out of date`);
    expect(io.err).toContain(`${FACTORY_LOCK} is out of date`);
    expect(io.err).toContain("bun scripts/image-locks/cli.ts refresh");
  });
});

describe("refreshImageLocks", () => {
  test("adds the new dependency to both locks and keeps release-package registry pins", () => {
    const root = workspace({ coreDependencies: addsNew });
    const calls: string[][] = [];

    const results = refreshImageLocks(root, deps(scriptedNpm(addsNewDependency, calls)));

    expect(results.map(({ lock, changed }) => ({ lock, changed }))).toEqual([
      { lock: CONTAINER_LOCK, changed: true },
      { lock: FACTORY_LOCK, changed: true },
    ]);
    for (const result of results) {
      expect(result.changes).toEqual([
        { kind: "added", path: "node_modules/acme-new", version: "3.1.0" },
      ]);
    }
    for (const lockPath of [CONTAINER_LOCK, FACTORY_LOCK]) {
      const refreshed = readLock(root, lockPath).packages;
      const core = refreshed["node_modules/@uniqbit/mate-core"]!;
      expect(core.dependencies).toEqual(addsNew);
      expect(core).toMatchObject(lockFixture().packages["node_modules/@uniqbit/mate-core"]!);
      expect(core.version).toBe("1.0.0");
      expect(JSON.stringify(refreshed)).not.toContain("file:");
      expect(refreshed["node_modules/acme-new"]).toBeDefined();
    }
    for (const call of calls.filter((args) => args[0] === "install")) {
      expect(call).toEqual(expect.arrayContaining(["--package-lock-only", "--ignore-scripts"]));
    }
    expect(checkImageLocks(root, { runNpm: spawnNpm }).flatMap(({ problems }) => problems)).toEqual(
      [],
    );
  });

  test("leaves release-owned Mate ranges to publication", () => {
    const root = workspace();

    refreshImageLocks(root, deps(scriptedNpm(() => {})));

    const cli = readLock(root, CONTAINER_LOCK).packages["node_modules/@uniqbit/mate"]!;
    expect(cli.dependencies).toMatchObject({ "@uniqbit/mate-core": "1.0.0" });
  });

  test("writes nothing when the locks are already current", () => {
    const root = workspace();
    const before = snapshot(root);
    const writes: string[] = [];

    const results = refreshImageLocks(
      root,
      deps(
        scriptedNpm(() => {}),
        { writeFile: (file) => void writes.push(file) },
      ),
    );

    expect(results.map(({ changed }) => changed)).toEqual([false, false]);
    expect(writes).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  test("allows the pin of a dependency whose declared range changed, and reports it", () => {
    const stale = lockFixture({ coreDependencies: { "acme-dep": "^1.0.0" } });
    const root = workspace({
      coreDependencies: { "acme-dep": "^1.5.0" },
      containerLock: stale,
      factoryLock: stale,
    });

    const results = refreshImageLocks(
      root,
      deps(
        scriptedNpm((lock) => {
          lock.packages["node_modules/acme-dep"] = pinned("acme-dep", "1.6.0");
        }),
      ),
    );

    expect(results[0]!.changes).toEqual([
      { kind: "changed", path: "node_modules/acme-dep", from: "1.2.0", to: "1.6.0" },
    ]);
  });

  test("allows a transitive pin that the changed dependency now requires", () => {
    const stale = lockFixture();
    stale.packages["node_modules/acme-dep"] = pinned("acme-dep", "1.2.0", {
      dependencies: { "acme-helper": "^1.0.0" },
    });
    stale.packages["node_modules/acme-helper"] = pinned("acme-helper", "1.0.0");
    const root = workspace({
      coreDependencies: { "acme-dep": "^1.5.0" },
      containerLock: stale,
      factoryLock: stale,
    });

    const results = refreshImageLocks(
      root,
      deps(
        scriptedNpm((lock) => {
          lock.packages["node_modules/acme-dep"] = pinned("acme-dep", "1.6.0", {
            dependencies: { "acme-helper": "^2.0.0" },
          });
          lock.packages["node_modules/acme-helper"] = pinned("acme-helper", "2.0.0");
        }),
      ),
    );

    expect(results[0]!.changes.map(({ path }) => path)).toEqual([
      "node_modules/acme-dep",
      "node_modules/acme-helper",
    ]);
  });

  test("fails and writes nothing when an unrelated pin would change", () => {
    const root = workspace({ coreDependencies: addsNew });
    const before = snapshot(root);

    expect(() =>
      refreshImageLocks(
        root,
        deps(
          scriptedNpm((lock) => {
            addsNewDependency(lock, 0);
            lock.packages["node_modules/acme-dep"] = pinned("acme-dep", "1.9.0");
          }),
        ),
      ),
    ).toThrow(/node_modules\/acme-dep 1\.2\.0 -> 1\.9\.0/);
    expect(snapshot(root)).toEqual(before);
  });

  test("replaces neither lock when one candidate cannot be produced", () => {
    const root = workspace({ coreDependencies: addsNew });
    const before = snapshot(root);
    let installs = 0;
    const runNpm = scriptedNpm(addsNewDependency);

    expect(() =>
      refreshImageLocks(
        root,
        deps((args, options) =>
          args[0] === "install" && installs++ === 1
            ? { status: 1, stdout: "", stderr: "npm error code ETARGET" }
            : runNpm(args, options),
        ),
      ),
    ).toThrow(/ETARGET/);
    expect(snapshot(root)).toEqual(before);
  });

  test("tells a registry outage from a resolution failure", () => {
    const root = workspace({ coreDependencies: addsNew });

    expect(() =>
      refreshImageLocks(
        root,
        deps(() => ({ status: 1, stdout: "", stderr: "npm error code ENOTFOUND" })),
      ),
    ).toThrow(/could not be reached/);
  });

  test("rejects a candidate that does not validate", () => {
    const root = workspace({ coreDependencies: addsNew });
    const before = snapshot(root);

    expect(() => refreshImageLocks(root, deps(scriptedNpm(() => {})))).toThrow(
      /the candidate is not valid/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  test("restores the first lock when replacing the second fails", () => {
    const root = workspace({ coreDependencies: addsNew });
    const before = snapshot(root);
    let renames = 0;

    expect(() =>
      refreshImageLocks(
        root,
        deps(scriptedNpm(addsNewDependency), {
          rename: (from, to) => {
            if (renames++ === 1) throw new Error("disk full");
            fs.renameSync(from, to);
          },
        }),
      ),
    ).toThrow("disk full");

    expect(snapshot(root)).toEqual(before);
    expect(fs.readdirSync(path.join(root, "apps/mate-factory/locks")).sort()).toEqual([
      "global-tools.package-lock.json",
      "global-tools.package.json",
    ]);
  });
});

describe("refresh command", () => {
  test("reports each lock's pin changes and the release provenance", () => {
    const root = workspace({ coreDependencies: addsNew });
    const io = captureIo();

    const status = refresh(root, deps(scriptedNpm(addsNewDependency)), io);

    expect(status).toBe(0);
    expect(io.out).toContain(`${CONTAINER_LOCK}: 1 pin change(s)`);
    expect(io.out).toContain(`${FACTORY_LOCK}: 1 pin change(s)`);
    expect(io.out).toContain("+ node_modules/acme-new 3.1.0");
    expect(io.out).toContain("Release preparation replaces them");
  });

  test("exits non-zero with the conflict when refresh fails", () => {
    const root = workspace({ coreDependencies: addsNew });
    const io = captureIo();

    const status = refresh(
      root,
      deps(() => ({ status: 1, stdout: "", stderr: "npm error code ETARGET" })),
      io,
    );

    expect(status).toBe(1);
    expect(io.err).toContain("ETARGET");
  });
});
