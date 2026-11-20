import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createTempDir } from "../../../../../test/fixtures";
import { mateHome } from "../../runtime/runtime-directory";
import { createTriageSession, triageRoot, triageSessionDir } from "./session";

const homes: string[] = [];

async function home(): Promise<string> {
  const dir = await createTempDir("mate-triage-session-");
  homes.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createTriageSession", () => {
  test("two runs at the same moment get two folders", async () => {
    const homeDir = await home();
    const now = new Date("2027-03-14T12:00:00.000Z");

    const first = createTriageSession({ homeDir, now });
    const second = createTriageSession({ homeDir, now });

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(triageRoot(homeDir));
    expect(fs.statSync(second).isDirectory()).toBe(true);
  });

  test("removes a 40-day-old session and touches nothing else under Mate's home", async () => {
    const homeDir = await home();
    const now = new Date("2027-03-14T12:00:00.000Z");
    const old = createTriageSession({ homeDir, now: new Date("2027-02-02T12:00:00.000Z") });
    const recent = createTriageSession({ homeDir, now: new Date("2027-03-04T12:00:00.000Z") });
    const stray = path.join(triageRoot(homeDir), "notes");
    const friction = path.join(mateHome(homeDir), "friction", "events-2026-01.jsonl");
    fs.mkdirSync(stray);
    fs.mkdirSync(path.dirname(friction), { recursive: true });
    fs.writeFileSync(friction, "");

    createTriageSession({ homeDir, now });

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.existsSync(friction)).toBe(true);
  });
});

describe("triageSessionDir", () => {
  test("names the session folder from the folder itself or a subfolder only", async () => {
    const homeDir = await home();
    const session = createTriageSession({ homeDir });
    const sub = path.join(session, "source");
    const stray = path.join(triageRoot(homeDir), "notes");
    const repository = path.join(homeDir, "acme");
    for (const dir of [sub, stray, repository]) fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(session);

    expect(triageSessionDir(session, homeDir)).toBe(real);
    expect(triageSessionDir(sub, homeDir)).toBe(real);
    expect(triageSessionDir(stray, homeDir)).toBeNull();
    expect(triageSessionDir(triageRoot(homeDir), homeDir)).toBeNull();
    expect(triageSessionDir(repository, homeDir)).toBeNull();
  });
});
