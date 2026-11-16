import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createTempDir } from "../../../../../test/fixtures";
import { launchAgent } from "./launch";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A fake agent CLI that records its folder and arguments, then exits 7. */
async function fakeAgent(name: string) {
  const root = await createTempDir("mate-triage-launch-");
  roots.push(root);
  const binary = path.join(root, name);
  const record = path.join(root, "record.txt");
  const sessionDir = path.join(root, "session");
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(binary, `#!/bin/sh\n{ pwd -P; printf '%s\\n' "$@"; } > "${record}"\nexit 7\n`, {
    mode: 0o755,
  });
  return { binary, record, sessionDir };
}

test.each([
  ["claude", ["acme prompt"]],
  ["opencode", ["--prompt", "acme prompt"]],
] as const)(
  "starts %s itself in the session folder with only the seed prompt",
  async (agent, args) => {
    const fake = await fakeAgent(agent);
    const code = await launchAgent({
      agent,
      binary: fake.binary,
      sessionDir: fake.sessionDir,
      prompt: "acme prompt",
    });

    expect(code).toBe(7);
    const [cwd, ...received] = fs.readFileSync(fake.record, "utf8").trimEnd().split("\n");
    expect(fs.realpathSync(cwd!)).toBe(fs.realpathSync(fake.sessionDir));
    expect(received).toEqual([...args]);
  },
);
