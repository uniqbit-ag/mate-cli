import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { reactDoctorPlugin } from "./react-doctor";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("reactDoctorPlugin", () => {
  test("teardown leaves companion Claude settings untouched", async () => {
    const companionPath = await makeTempDir("mate-react-doctor-claude-teardown-");
    const settingsPath = path.join(companionPath, ".claude", "settings.local.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PostToolBatch: [{ hooks: [{ type: "command", command: 'sh "/tmp/react-doctor.sh"' }] }],
            PreToolUse: [{ matcher: "Write", hooks: [] }],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    await reactDoctorPlugin.forProvider?.claude?.teardown?.({
      companionPath,
      config: {
        profiles: { default: { name: "default", allowedAgents: ["claude"] } },
        capabilities: [{ name: "react-doctor" }],
      },
      stage: "setup",
      activeProviders: [],
    } as never);

    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(settings.hooks.PostToolBatch).toEqual([
      { hooks: [{ type: "command", command: 'sh "/tmp/react-doctor.sh"' }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "Write", hooks: [] }]);
  });
});
