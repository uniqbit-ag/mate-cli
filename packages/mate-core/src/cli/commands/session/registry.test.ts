import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSessionRegistryCommand } from "./registry";

let home: string;
let file: string;
let work: string;
let exitCode: typeof process.exitCode;

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "acme-session-cmd-")));
  file = path.join(home, ".mate", "sessions.json");
  work = path.join(home, "acme");
  await fs.mkdir(work);
  exitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(async () => {
  process.exitCode = exitCode;
  await fs.rm(home, { recursive: true, force: true });
});

async function run(subcommand: "add" | "list" | "remove", argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const error = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => void err.push(a.join(" ")),
  );
  const write = spyOn(process.stdout, "write").mockImplementation(((
    chunk: string,
    cb?: () => void,
  ) => {
    out.push(String(chunk));
    cb?.();
    return true;
  }) as never);
  try {
    await runSessionRegistryCommand(subcommand, argv, file);
  } finally {
    error.mockRestore();
    write.mockRestore();
  }
  return { out: out.join(""), err: err.join("\n"), code: process.exitCode };
}

describe("mate session add|list|remove", () => {
  test("add prints the session, list shows it, remove deletes it", async () => {
    const added = await run("add", ["--runtime", "claude", "--id", "s1", "--cwd", work, "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out)).toMatchObject({ id: "s1", runtime: "claude", cwd: work });

    const listed = await run("list", ["--json"]);
    expect(JSON.parse(listed.out)).toMatchObject({ version: 1, sessions: [{ id: "s1" }] });

    const removed = await run("remove", ["s1", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse((await run("list", ["--json"])).out).sessions).toEqual([]);
  });

  test("duplicate id exits non-zero", async () => {
    await run("add", ["--runtime", "claude", "--id", "s1", "--cwd", work, "--json"]);
    const again = await run("add", ["--runtime=claude", "--id=s1", `--cwd=${work}`, "--json"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already registered");
    expect(again.out).toBe("");
  });

  test("unknown runtime, missing flags, and unknown id exit non-zero", async () => {
    expect((await run("add", ["--runtime", "vim", "--id", "s1", "--cwd", work])).code).toBe(1);
    process.exitCode = 0;
    expect((await run("add", ["--id", "s1"])).err).toContain("--runtime");
    process.exitCode = 0;
    expect((await run("remove", ["nope", "--json"])).err).toContain("not registered");
  });

  test("invalid file exits non-zero naming it", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "[");
    const listed = await run("list", ["--json"]);
    expect(listed.code).toBe(1);
    expect(listed.err).toContain(file);
  });
});
