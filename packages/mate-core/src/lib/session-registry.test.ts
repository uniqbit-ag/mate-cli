import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addSession,
  listSessions,
  readSessionRegistry,
  removeSession,
  SessionRegistryError,
} from "./session-registry";

let home: string;
let file: string;
let work: string;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-sessions-")));
  file = path.join(home, ".mate", "sessions.json");
  work = path.join(home, "acme");
  await fs.mkdir(work);
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);

describe("session registry", () => {
  test("missing file reads as empty", async () => {
    expect(await readSessionRegistry(file)).toEqual({ version: 1, sessions: [] });
  });

  test("first add creates the file with version 1", async () => {
    const added = await addSession(
      { id: "s1", runtime: "claude", cwd: work },
      { file, now: at("2026-01-01T00:00:00.000Z") },
    );
    expect(added).toEqual({
      id: "s1",
      runtime: "claude",
      cwd: work,
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 1, sessions: [added] });
  });

  test("lists newest first", async () => {
    await addSession(
      { id: "old", runtime: "claude", cwd: work },
      { file, now: at("2026-01-01T00:00:00Z") },
    );
    await addSession(
      { id: "new", runtime: "opencode", cwd: work },
      { file, now: at("2026-02-01T00:00:00Z") },
    );
    expect((await listSessions(file)).sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  test("refuses unknown runtime, missing directory, and duplicate id without writing", async () => {
    await expect(addSession({ id: "s1", runtime: "vim", cwd: work }, { file })).rejects.toThrow(
      SessionRegistryError,
    );
    await expect(
      addSession({ id: "s1", runtime: "claude", cwd: path.join(home, "gone") }, { file }),
    ).rejects.toThrow("directory does not exist");
    await expect(fs.stat(file)).rejects.toThrow();

    await addSession({ id: "s1", runtime: "claude", cwd: work }, { file });
    const before = await fs.readFile(file, "utf8");
    await expect(addSession({ id: "s1", runtime: "claude", cwd: work }, { file })).rejects.toThrow(
      "already registered",
    );
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  test("remove deletes one record and refuses an unknown id", async () => {
    await addSession({ id: "a", runtime: "claude", cwd: work }, { file });
    await addSession({ id: "b", runtime: "claude", cwd: work }, { file });
    await removeSession("a", file);
    expect((await listSessions(file)).sessions.map((s) => s.id)).toEqual(["b"]);
    await expect(removeSession("a", file)).rejects.toThrow("not registered");
  });

  test("invalid JSON is refused and left unchanged", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{nope");
    await expect(listSessions(file)).rejects.toThrow(file);
    await expect(addSession({ id: "s1", runtime: "claude", cwd: work }, { file })).rejects.toThrow(
      SessionRegistryError,
    );
    await expect(removeSession("s1", file)).rejects.toThrow(SessionRegistryError);
    expect(await fs.readFile(file, "utf8")).toBe("{nope");
  });
});
