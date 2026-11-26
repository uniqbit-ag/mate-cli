import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { frictionLogDir } from "./friction-log";
import { frictionSwitchFile, readFrictionSwitch, writeFrictionSwitch } from "./friction-switch";

const tempRoots: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-friction-switch-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("an absent file reads as off and the read creates nothing", () => {
  const home = tempHome();
  expect(readFrictionSwitch(home)).toBe(false);
  expect(fs.existsSync(frictionLogDir(home))).toBe(false);
});

test("a malformed file reads as off", () => {
  const home = tempHome();
  fs.mkdirSync(frictionLogDir(home), { recursive: true });
  fs.writeFileSync(frictionSwitchFile(home), "{ recording: true");
  expect(readFrictionSwitch(home)).toBe(false);
  fs.writeFileSync(frictionSwitchFile(home), '{"recording":"yes"}');
  expect(readFrictionSwitch(home)).toBe(false);
});

test("a written switch reads back", () => {
  const home = tempHome();
  writeFrictionSwitch(true, home);
  expect(readFrictionSwitch(home)).toBe(true);
  writeFrictionSwitch(false, home);
  expect(readFrictionSwitch(home)).toBe(false);
  expect(fs.readdirSync(frictionLogDir(home))).toEqual(["settings.json"]);
});
