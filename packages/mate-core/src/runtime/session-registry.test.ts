import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  addSession,
  endSession,
  listSessions,
  patchSession,
  readSessionRegistry,
  refreshSession,
  removeSession,
  SessionRegistryError,
  withLock,
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
    expect(await readSessionRegistry(file)).toEqual({ version: 2, sessions: [] });
  });

  test("first add creates the file with version 2", async () => {
    const added = await addSession(
      { id: "s1", runtime: "claude", cwd: work },
      { file, now: at("2026-01-01T00:00:00.000Z") },
    );
    expect(added).toEqual({
      id: "s1",
      runtime: "claude",
      origin: "editor",
      cwd: work,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 2, sessions: [added] });
  });

  test("a version 1 file is read as editor sessions and written back as version 2", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const v1 = { id: "old", runtime: "claude", cwd: work, startedAt: "2026-01-01T00:00:00.000Z" };
    await fs.writeFile(file, JSON.stringify({ version: 1, sessions: [v1] }));
    expect((await readSessionRegistry(file)).sessions[0]).toEqual({
      ...v1,
      origin: "editor",
      lastSeenAt: v1.startedAt,
    });
    await addSession({ id: "new", runtime: "opencode", cwd: work, origin: "unmanaged" }, { file });
    const written = JSON.parse(await fs.readFile(file, "utf8"));
    expect(written.version).toBe(2);
    expect(written.sessions.map((s: { origin: string }) => s.origin)).toEqual([
      "editor",
      "unmanaged",
    ]);
  });

  test("lists newest lastSeenAt first", async () => {
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

  test("refuses unknown runtime, unknown origin, and missing directory without writing", async () => {
    await expect(addSession({ id: "s1", runtime: "vim", cwd: work }, { file })).rejects.toThrow(
      SessionRegistryError,
    );
    await expect(
      addSession({ id: "s1", runtime: "claude", cwd: work, origin: "x" }, { file }),
    ).rejects.toThrow("unknown origin");
    await expect(
      addSession({ id: "s1", runtime: "claude", cwd: path.join(home, "gone") }, { file }),
    ).rejects.toThrow("directory does not exist");
    await expect(fs.stat(file)).rejects.toThrow();
  });

  test("a registered id is refreshed: new cwd and lastSeenAt, endedAt cleared, the rest kept", async () => {
    const other = path.join(home, "acme-wt");
    await fs.mkdir(other);
    await addSession(
      { id: "s1", runtime: "claude", cwd: work, origin: "editor" },
      { file, now: at("2026-01-01T00:00:00.000Z") },
    );
    await patchSession(
      "s1",
      { label: "Fix the queue", change: "acme-queue", attentionAt: "2026-01-01T12:00:00.000Z" },
      { file },
    );
    await endSession("s1", { file, now: at("2026-01-02T00:00:00.000Z") });

    const refreshed = await addSession(
      {
        id: "s1",
        runtime: "claude",
        cwd: other,
        origin: "managed",
        pid: 42,
        branch: "workset/acme",
      },
      { file, now: at("2026-01-03T00:00:00.000Z") },
    );
    expect(refreshed).toEqual({
      id: "s1",
      runtime: "claude",
      origin: "editor",
      cwd: other,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
      pid: 42,
      branch: "workset/acme",
      label: "Fix the queue",
      change: "acme-queue",
      attentionAt: "2026-01-01T12:00:00.000Z",
    });
    expect((await listSessions(file)).sessions).toHaveLength(1);
  });

  test("patch and end return null for an unknown id", async () => {
    expect(await patchSession("nope", { change: "acme" }, { file })).toBeNull();
    expect(await endSession("nope", { file })).toBeNull();
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

  test("concurrent writers keep every session", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${index}`);
    await Promise.all(ids.map((id) => addSession({ id, runtime: "claude", cwd: work }, { file })));
    expect((await listSessions(file)).sessions.map((s) => s.id).toSorted()).toEqual(ids.toSorted());
  });

  test("a held lock times out; a stale one is taken over", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.lock`, "");
    await expect(
      addSession({ id: "s1", runtime: "claude", cwd: work }, { file, lock: { waitMs: 50 } }),
    ).rejects.toThrow("locked");

    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    await addSession({ id: "s1", runtime: "claude", cwd: work }, { file, lock: { waitMs: 50 } });
    expect((await listSessions(file)).sessions.map((s) => s.id)).toEqual(["s1"]);
    await expect(fs.stat(`${file}.lock`)).rejects.toThrow();
  });

  test("a slow writer keeps its lock fresh; a lock it no longer owns is left alone", async () => {
    const lock = `${file}.lock`;
    await withLock(
      file,
      async () => {
        const old = new Date(Date.now() - 60_000);
        await fs.utimes(lock, old, old);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(Date.now() - (await fs.stat(lock)).mtimeMs).toBeLessThan(1000);
      },
      { staleMs: 90 },
    );
    await expect(fs.stat(lock)).rejects.toThrow();

    await withLock(file, async () => {
      await fs.writeFile(lock, "another writer");
    });
    expect(await fs.readFile(lock, "utf8")).toBe("another writer");
  });

  test("refresh and patch of an unregistered session write nothing", async () => {
    expect(await refreshSession({ id: "s1", runtime: "claude", cwd: work }, { file })).toBeNull();
    expect(await patchSession("s1", { label: "x" }, { file })).toBeNull();
    expect(await endSession("s1", { file })).toBeNull();
    await expect(fs.stat(file)).rejects.toThrow();

    await addSession({ id: "s1", runtime: "claude", cwd: work }, { file });
    const refreshed = await refreshSession(
      { id: "s1", runtime: "claude", cwd: work, branch: "main" },
      { file },
    );
    expect(refreshed?.branch).toBe("main");
  });

  test("a new session drops month-old ended or orphaned ones", async () => {
    const old = () => new Date("2026-01-01T00:00:00.000Z");
    const gone = path.join(home, "acme-gone");
    await fs.mkdir(gone);
    await addSession({ id: "ended", runtime: "claude", cwd: work }, { file, now: old });
    await endSession("ended", { file, now: old });
    await addSession({ id: "orphan", runtime: "claude", cwd: gone }, { file, now: old });
    await fs.rm(gone, { recursive: true });
    await addSession({ id: "parked", runtime: "claude", cwd: work }, { file, now: old });
    await addSession({ id: "new", runtime: "claude", cwd: work }, { file });
    expect((await listSessions(file)).sessions.map((s) => s.id)).toEqual(["new", "parked"]);
  });
});
