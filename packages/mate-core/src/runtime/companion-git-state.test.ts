import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  companionGitStatePath,
  readCompanionGitRecord,
  recordCompanionSync,
  readSubmittedFolders,
  recordForkVerdict,
  updateSubmittedFolders,
} from "./companion-git-state";

let home: string;
const companion = "/acme/companion";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mate-git-state-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("companion Git state", () => {
  test("records submitted folders alongside other fields and forgets dropped ones", () => {
    recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home);
    const at = "2026-11-14T10:00:00.000Z";
    updateSubmittedFolders(
      companion,
      {
        "openspec/changes/acme-login": { digest: "a1", submittedAt: at },
        "openspec/changes/acme-glossary": { digest: "b2", submittedAt: at },
      },
      [],
      home,
    );
    updateSubmittedFolders(companion, {}, ["openspec/changes/acme-glossary"], home);

    expect(readSubmittedFolders(companion, home)).toEqual({
      "openspec/changes/acme-login": { digest: "a1", submittedAt: at },
    });
    expect(readCompanionGitRecord(companion, home).syncedAt).toBe("2026-11-13T10:00:00.000Z");
  });

  test("keeps every field when writers update the record in turn", () => {
    recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home);
    recordForkVerdict(
      companion,
      { ahead: 1, behind: 0 },
      new Date("2026-11-13T11:00:00.000Z"),
      home,
    );

    expect(readCompanionGitRecord(companion, home)).toEqual({
      syncedAt: "2026-11-13T10:00:00.000Z",
      fork: { ahead: 1, behind: 0, checkedAt: "2026-11-13T11:00:00.000Z" },
    });
    expect(fs.readdirSync(path.dirname(companionGitStatePath(companion, home)))).toHaveLength(1);
  });

  test("takes over a lock a dead writer left behind", () => {
    const lock = `${companionGitStatePath(companion, home)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "0");
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);

    expect(recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home)).toBe(true);
    expect(readCompanionGitRecord(companion, home).syncedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("a breaker that died is removed, and the stale lock is broken afterwards", () => {
    const lock = `${companionGitStatePath(companion, home)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    for (const file of [lock, `${lock}.break`]) {
      fs.writeFileSync(file, "0");
      fs.utimesSync(file, stale, stale);
    }

    expect(recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home)).toBe(true);
    expect(readCompanionGitRecord(companion, home).syncedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(`${lock}.break`)).toBe(false);
  });

  test("gives up on a lock path it cannot read instead of spinning", () => {
    const lock = `${companionGitStatePath(companion, home)}.lock`;
    fs.mkdirSync(lock, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);

    expect(recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home)).toBe(true);
    expect(readCompanionGitRecord(companion, home).syncedAt).toBe("2026-11-13T10:00:00.000Z");
    expect(fs.statSync(lock).isDirectory()).toBe(true);
  });

  test("leaves a lock another writer holds", () => {
    const lock = `${companionGitStatePath(companion, home)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "1 live");

    expect(recordCompanionSync(companion, new Date("2026-11-13T10:00:00.000Z"), home)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("1 live");
  });
});
