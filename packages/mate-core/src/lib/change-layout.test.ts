import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  activeChanges,
  archiveAnchors,
  changeNameOf,
  deltaSpecs,
  isChangeName,
  locateChange,
  parseAnchor,
} from "./change-layout";

let companion: string;
let changes: string;
let archive: string;

beforeEach(async () => {
  companion = await fs.mkdtemp(path.join(os.tmpdir(), "change-layout-"));
  changes = path.join(companion, "openspec", "changes");
  archive = path.join(changes, "archive");
  await fs.mkdir(archive, { recursive: true });
});

afterEach(async () => {
  await fs.rm(companion, { recursive: true, force: true });
});

async function touch(file: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

describe("names and anchors", () => {
  test("a change name is one segment that is not the archive directory", () => {
    expect(isChangeName("acme")).toBe(true);
    expect(isChangeName("2026-01-02-acme")).toBe(true);
    // Wider than kebab-case: archives made under older naming rules still resolve.
    expect(isChangeName("2025-05-01-Acme+Fix")).toBe(true);
    for (const name of ["", ".", "..", "../acme", "a/b", "a\\b", "archive", ".hidden"]) {
      expect(isChangeName(name)).toBe(false);
    }
  });

  test("an anchor needs a date and a change name", () => {
    expect(parseAnchor("2026-01-02-acme")).toEqual({ date: "2026-01-02", name: "acme" });
    expect(parseAnchor("2026-01-02-")).toBeNull();
    expect(parseAnchor("2026-01-02-../x")).toBeNull();
    expect(parseAnchor("2025-05-01-Acme+Fix")).toEqual({ date: "2025-05-01", name: "Acme+Fix" });
    expect(parseAnchor("acme")).toBeNull();
    expect(changeNameOf("2026-01-02-acme")).toBe("acme");
    expect(changeNameOf("acme")).toBe("acme");
  });
});

describe("listing", () => {
  test("active changes are directories other than the archive", async () => {
    await fs.mkdir(path.join(changes, "beta"));
    await fs.mkdir(path.join(changes, "acme"));
    await touch(path.join(changes, "notes.md"));
    expect(await activeChanges(companion)).toEqual(["acme", "beta"]);
  });

  test("archive anchors are dated directories with a name, oldest first", async () => {
    await fs.mkdir(path.join(archive, "2026-03-04-acme"));
    await fs.mkdir(path.join(archive, "2026-01-02-acme"));
    await fs.mkdir(path.join(archive, "2026-02-02-acme-two"));
    await fs.mkdir(path.join(archive, "2026-02-02-"));
    await fs.mkdir(path.join(archive, "undated"));
    await touch(path.join(archive, "2026-05-06-acme"));
    expect(await archiveAnchors(companion)).toEqual([
      "2026-01-02-acme",
      "2026-02-02-acme-two",
      "2026-03-04-acme",
    ]);
    expect(await archiveAnchors(companion, "acme")).toEqual(["2026-01-02-acme", "2026-03-04-acme"]);
  });

  test("a missing changes directory lists nothing", async () => {
    await fs.rm(changes, { recursive: true });
    expect(await activeChanges(companion)).toEqual([]);
    expect(await archiveAnchors(companion)).toEqual([]);
  });
});

describe("locateChange", () => {
  test("active change wins over its archives", async () => {
    await fs.mkdir(path.join(changes, "acme"));
    await fs.mkdir(path.join(archive, "2026-01-02-acme"));
    expect(await locateChange(companion, "acme")).toEqual({
      dir: path.join(changes, "acme"),
      archived: false,
    });
  });

  test("newest archive resolves a bare name", async () => {
    await fs.mkdir(path.join(archive, "2026-01-02-acme"));
    await fs.mkdir(path.join(archive, "2026-03-04-acme"));
    expect(await locateChange(companion, "acme")).toEqual({
      dir: path.join(archive, "2026-03-04-acme"),
      archived: true,
    });
  });

  test("a dated anchor resolves exactly", async () => {
    await fs.mkdir(path.join(archive, "2026-01-02-acme"));
    await fs.mkdir(path.join(archive, "2026-03-04-acme"));
    expect(await locateChange(companion, "2026-01-02-acme")).toEqual({
      dir: path.join(archive, "2026-01-02-acme"),
      archived: true,
    });
  });

  test("a file named like an archive is ignored", async () => {
    await touch(path.join(archive, "2026-05-06-acme"));
    expect(await locateChange(companion, "acme")).toBeNull();
    expect(await locateChange(companion, "2026-05-06-acme")).toBeNull();
  });

  test("path-like targets and the archive directory resolve to nothing", async () => {
    await fs.mkdir(path.join(companion, "openspec", "acme"), { recursive: true });
    for (const target of ["../acme", "archive", "..", ".", "a/b", ""]) {
      expect(await locateChange(companion, target)).toBeNull();
    }
  });
});

describe("deltaSpecs", () => {
  test("maps every file at any depth and names spec.md capabilities", async () => {
    const change = path.join(changes, "acme");
    await touch(path.join(change, "specs", "billing", "spec.md"));
    await touch(path.join(change, "specs", "identity", "user-auth", "spec.md"));
    await touch(path.join(change, "specs", "identity", "user-auth", "notes.md"));
    await touch(path.join(change, "specs", "spec.md"));
    expect(await deltaSpecs(change)).toEqual([
      {
        file: "billing/spec.md",
        canonical: "openspec/specs/billing/spec.md",
        capability: "billing",
      },
      {
        file: "identity/user-auth/notes.md",
        canonical: "openspec/specs/identity/user-auth/notes.md",
        capability: null,
      },
      {
        file: "identity/user-auth/spec.md",
        canonical: "openspec/specs/identity/user-auth/spec.md",
        capability: "identity/user-auth",
      },
      { file: "spec.md", canonical: "openspec/specs/spec.md", capability: null },
    ]);
  });

  test("file contents never change the result", async () => {
    const change = path.join(changes, "acme");
    await touch(path.join(change, "specs", "billing", "spec.md"), "../../../etc/passwd\n");
    expect((await deltaSpecs(change)).map((spec) => spec.canonical)).toEqual([
      "openspec/specs/billing/spec.md",
    ]);
  });

  test("a change without specs has none", async () => {
    expect(await deltaSpecs(path.join(changes, "missing"))).toEqual([]);
  });
});
