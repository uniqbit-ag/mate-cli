import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { companionLockPath, withCompanionLock } from "./companion-lock";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("withCompanionLock", () => {
  test("lives under <mate home>/locks, outside the companion", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");

    const lockPath = companionLockPath(companion, home);

    expect(lockPath.startsWith(path.join(home, ".mate", "locks"))).toBe(true);
    expect(lockPath.startsWith(companion)).toBe(false);
  });

  test("serializes two runs on one companion", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const events: string[] = [];
    const run = (name: string) =>
      withCompanionLock(companion, { homeDir: home, timeoutMs: 5_000, pollMs: 5 }, async () => {
        events.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`${name}:end`);
      });

    await Promise.all([run("a"), run("b")]);

    expect(events).toHaveLength(4);
    expect(events[1]).toBe(`${events[0]!.split(":")[0]}:end`);
    await expect(fs.access(companionLockPath(companion, home))).rejects.toThrow();
  });

  test("never lets two of many concurrent runs hold the lock at once", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    let holders = 0;
    let maxHolders = 0;
    const run = () =>
      withCompanionLock(companion, { homeDir: home, timeoutMs: 10_000, pollMs: 1 }, async () => {
        holders += 1;
        maxHolders = Math.max(maxHolders, holders);
        await new Promise((resolve) => setTimeout(resolve, 2));
        holders -= 1;
      });

    const results = await Promise.all(Array.from({ length: 20 }, run));

    expect(results.every((result) => result.acquired)).toBe(true);
    expect(maxHolders).toBe(1);
  });

  test("an empty lock file is held, not stale", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "");

    const result = await withCompanionLock(
      companion,
      { homeDir: home, timeoutMs: 50, pollMs: 5 },
      async () => "ran",
    );

    expect(result).toEqual({ acquired: false });
    expect(await fs.readFile(lockPath, "utf8")).toBe("");
  });

  test("gives up after the bounded wait and reports it", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid));

    const result = await withCompanionLock(
      companion,
      { homeDir: home, timeoutMs: 50, pollMs: 5 },
      async () => "ran",
    );

    expect(result).toEqual({ acquired: false });
  });

  test("takes over a lock whose holder is gone", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "999999999");

    const result = await withCompanionLock(
      companion,
      { homeDir: home, timeoutMs: 50, pollMs: 5 },
      async () => "ran",
    );

    expect(result).toEqual({ acquired: true, value: "ran" });
  });

  test("wait: false returns at once when the lock is held", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid));
    const task = mock(async () => "ran");

    const started = Date.now();
    const result = await withCompanionLock(
      companion,
      { homeDir: home, wait: false, timeoutMs: 5_000 },
      task,
    );

    expect(result).toEqual({ acquired: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(task).not.toHaveBeenCalled();
  });

  test("wait: false runs the task when the lock is free", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");

    const result = await withCompanionLock(
      companion,
      { homeDir: home, wait: false },
      async () => "ran",
    );

    expect(result).toEqual({ acquired: true, value: "ran" });
    await expect(fs.access(companionLockPath(companion, home))).rejects.toThrow();
  });

  test("a nested acquisition in the same call chain does not deadlock", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);

    const result = await withCompanionLock(
      companion,
      { homeDir: home, timeoutMs: 200, pollMs: 5 },
      async () => {
        const inner = await withCompanionLock(
          companion,
          { homeDir: home, wait: false },
          async () => "inner",
        );
        /** The outer holder still owns the lock after the nested release. */
        expect(await fs.readFile(lockPath, "utf8")).toBe(String(process.pid));
        return inner;
      },
    );

    expect(result).toEqual({ acquired: true, value: { acquired: true, value: "inner" } });
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  test("a throw inside a nested acquisition leaves the lock to the outer holder", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const lockPath = companionLockPath(companion, home);

    await expect(
      withCompanionLock(companion, { homeDir: home }, async () => {
        await withCompanionLock(companion, { homeDir: home }, async () => {
          throw new Error("acme failed");
        }).catch(() => {});
        expect(await fs.readFile(lockPath, "utf8")).toBe(String(process.pid));
        throw new Error("outer failed");
      }),
    ).rejects.toThrow("outer failed");

    await expect(fs.access(lockPath)).rejects.toThrow();
    const next = await withCompanionLock(
      companion,
      { homeDir: home, wait: false },
      async () => "next",
    );
    expect(next).toEqual({ acquired: true, value: "next" });
  });

  test("re-entrancy does not leak to an unrelated concurrent caller", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const outer = withCompanionLock(companion, { homeDir: home }, () => held);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const other = await withCompanionLock(
      companion,
      { homeDir: home, wait: false },
      async () => "other",
    );

    release();
    await outer;
    expect(other).toEqual({ acquired: false });
  });

  test("reports a wait once, only when the lock is held", async () => {
    const home = await makeTempDir("acme-home-");
    const companion = await makeTempDir("acme-companion-");
    const onWait = mock(() => {});

    await withCompanionLock(companion, { homeDir: home, onWait }, async () => {});
    expect(onWait).not.toHaveBeenCalled();

    const lockPath = companionLockPath(companion, home);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, String(process.pid));
    setTimeout(() => void fs.rm(lockPath, { force: true }), 40);

    const result = await withCompanionLock(
      companion,
      { homeDir: home, pollMs: 5, timeoutMs: 5_000, onWait },
      async () => "ran",
    );

    expect(result).toEqual({ acquired: true, value: "ran" });
    expect(onWait).toHaveBeenCalledTimes(1);
  });
});
