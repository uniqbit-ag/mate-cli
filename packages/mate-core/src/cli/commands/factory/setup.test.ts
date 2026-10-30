import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFactoryCredential, runFactorySetup, type SetupIo } from "./setup";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mate-factory-setup-"));
  file = path.join(dir, ".mate", "factory", "credential.env");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Real credentials are about 100 characters. */
const TOKEN = `sk-ant-oat01-${"acme".repeat(24)}`;
const API_KEY = `sk-ant-api03-${"acme".repeat(24)}`;

function io(answers: string[], hidden: string, isTTY = true) {
  const output: string[] = [];
  const queue = [...answers];
  const terminal: SetupIo = {
    isTTY,
    ask: async (question) => {
      output.push(question);
      return queue.shift() ?? "";
    },
    askHidden: async () => hidden,
    write: (text) => void output.push(text),
  };
  return { terminal, output: () => output.join("") };
}

describe("mate factory setup", () => {
  test("stores a subscription token, readable by the user only, and never prints it", async () => {
    const { terminal, output } = io(["1"], TOKEN);
    expect(await runFactorySetup(terminal, file)).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(output()).not.toContain(TOKEN);
    expect(await readFactoryCredential(file)).toEqual({
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: TOKEN,
    });
  });

  test("an API key replaces a stored token, so exactly one credential is stored", async () => {
    await runFactorySetup(io(["1"], TOKEN).terminal, file);
    await runFactorySetup(io(["2"], API_KEY).terminal, file);
    expect(fs.readFileSync(file, "utf8")).toBe(`ANTHROPIC_API_KEY=${API_KEY}\n`);
  });

  test("a value that does not look like the chosen kind is stored only when confirmed", async () => {
    expect(await runFactorySetup(io(["1", "n"], API_KEY).terminal, file)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(await runFactorySetup(io(["1", "y"], "acme-other").terminal, file)).toBe(0);
  });

  test("a value cut short at a line break is stored only when confirmed", async () => {
    const cut = TOKEN.slice(0, 41);
    const declined = io(["1", "n"], cut);
    expect(await runFactorySetup(declined.terminal, file)).toBe(1);
    expect(declined.output()).toContain("cut at a line break");
    expect(fs.existsSync(file)).toBe(false);
    expect(await runFactorySetup(io(["1", "y"], cut).terminal, file)).toBe(0);
  });

  test.each([
    ["no terminal", io(["1"], TOKEN, false)],
    ["an unknown choice", io(["3"], TOKEN)],
    ["an empty value", io(["1"], "")],
    ["whitespace in the value", io(["1"], "sk-ant-oat01 acme")],
  ])("stores nothing for %s", async (_name, { terminal }) => {
    expect(await runFactorySetup(terminal, file)).toBe(1);
    expect(fs.existsSync(file)).toBe(false);
  });
});
