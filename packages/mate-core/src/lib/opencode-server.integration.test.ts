import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { activeSessions, readServerRecord } from "../runtime/opencode-server-record";
import { defaultServerDeps, ensureOpenCodeServer } from "./opencode-server";
import { OpenCodeAdapter } from "./orchestrator/adapters/opencode";

/**
 * Opt-in: `MATE_TEST_REAL_OPENCODE=1` starts a real `opencode serve` (2.x) on
 * loopback. No model is called.
 */
const REAL_OPENCODE = process.env.MATE_TEST_REAL_OPENCODE === "1";
const TIMEOUT = 60_000;

describe.skipIf(!REAL_OPENCODE)("a real Mate OpenCode server", () => {
  let root: string;
  let repo: string;
  let deps: typeof defaultServerDeps;
  let input: Parameters<typeof ensureOpenCodeServer>[0];

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acme-opencode-server-")));
    repo = path.join(root, "acme");
    fs.mkdirSync(repo);
    deps = { ...defaultServerDeps, dir: path.join(root, "servers") };
    input = { repositoryId: "acme", cwd: repo, env: { ...process.env, MATE_GUIDANCE_JSON: "" } };
  });

  afterAll(async () => {
    const record = await readServerRecord(path.join(deps.dir, "acme"));
    if (record) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test(
    "requires its password, is reused, and serves the client launch",
    async () => {
      const server = await ensureOpenCodeServer(input, deps);
      expect(await activeSessions(server.url, server.password)).toEqual([]);
      expect(await activeSessions(server.url, "wrong")).toBeNull();
      const unauthenticated = await fetch(`${server.url}/api/session/active`);
      expect(unauthenticated.status).toBe(401);

      const again = await ensureOpenCodeServer(input, deps);
      expect(again.url).toBe(server.url);

      const adapter = new OpenCodeAdapter(undefined, (serverInput) =>
        ensureOpenCodeServer({ ...serverInput, env: input.env }, deps),
      );
      const launch = await adapter.prepareLaunch(
        {
          repository: { id: "acme", path: repo },
          launchWorkingDirectory: repo,
          allowedAgents: ["opencode"],
          companionPath: root,
          capabilities: [],
        },
        ["--bg", "--session", "ses_1"],
      );
      expect(launch.args).toEqual([repo, "--session", "ses_1", "--server", server.url]);
      expect(launch.env.OPENCODE_PASSWORD).toBe(server.password);
    },
    TIMEOUT,
  );
});
