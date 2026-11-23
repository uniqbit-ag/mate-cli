import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createTempDir } from "../../../../../test/fixtures";
import { spawnNextHandoff } from "./next-handoff-process";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "the launcher sees no agent session id, so a failed `workflow next` is not agent friction",
  async () => {
    const root = await createTempDir("mate-next-handoff-");
    roots.push(root);
    const launcher = path.join(root, "mate");
    fs.writeFileSync(
      launcher,
      '#!/bin/sh\necho "{\\"ok\\":true,\\"handoff\\":\\"${CLAUDE_CODE_SESSION_ID-unset} ${OPENCODE_SESSION_ID-unset}\\"}"\n',
      { mode: 0o755 },
    );
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: "s-claude", OPENCODE_SESSION_ID: "s-oc" };

    const printed = await spawnNextHandoff(launcher, env)("acme-fix", root);

    expect(printed?.handoff).toBe("unset unset");
  },
);
