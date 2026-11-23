import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";

import { createTempDir, overrideEnv } from "../../../../test/fixtures";
import { spawnPrepareRunner } from "./session-prepare-runner";

const roots: string[] = [];
let restoreEnv: (() => void) | undefined;

afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "the launcher sees no agent session id, so a failed prepare is not agent friction",
  async () => {
    const root = await createTempDir("mate-prepare-runner-");
    roots.push(root);
    const launcher = path.join(root, "mate");
    fs.writeFileSync(
      launcher,
      '#!/bin/sh\necho "{\\"ok\\":true,\\"warnings\\":[\\"${CLAUDE_CODE_SESSION_ID-unset} ${OPENCODE_SESSION_ID-unset}\\"]}"\n',
      { mode: 0o755 },
    );
    restoreEnv = overrideEnv({ CLAUDE_CODE_SESSION_ID: "s-claude", OPENCODE_SESSION_ID: "s-oc" });

    const run = await spawnPrepareRunner(launcher, root)({ sync: false });

    expect(run.notes).toEqual(["unset unset"]);
  },
);
