import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

import type { FactoryClient } from "../../../lib/factory/client";
import { createWorksetResolver } from "./workset-session";

let root: string;
let companion: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mate-workset-session-")));
  companion = path.join(root, "acme-companion");
  fs.mkdirSync(path.join(companion, "worksets"), { recursive: true });
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function record(id: string, body: string): void {
  fs.writeFileSync(path.join(companion, "worksets", `${id}.yaml`), `id: ${id}\n${body}`);
}

function fakeClient(
  options: {
    credential?: string | null;
    conversation?: boolean;
    linkFails?: boolean;
    prepareFails?: string;
    warnings?: string[];
  } = {},
) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    info: async () => ({
      credential: options.credential === undefined ? "subscription" : options.credential,
    }),
    spawn: async (request: unknown) => {
      calls.push(["spawn", request]);
      return options.warnings ? { warnings: options.warnings } : {};
    },
    exec: async (request: { command: string[] }) => {
      calls.push(["exec", request.command]);
      if (request.command[0] === "node") return { status: 0, stdout: "", stderr: "" };
      if (request.command[1] === "claude") {
        return options.prepareFails
          ? { status: 1, stdout: "", stderr: `${options.prepareFails}\nstack line` }
          : { status: 0, stdout: "wrapped acme/web for Claude\nSyncing tokensave...", stderr: "" };
      }
      if (request.command[1] === "working") {
        return options.linkFails
          ? { status: 1, stdout: "", stderr: "acme link broke" }
          : { status: 0, stdout: "", stderr: "" };
      }
      return { status: options.conversation ? 0 : 1, stdout: "", stderr: "" };
    },
  } as unknown as FactoryClient;
  return { client, calls };
}

function resolver(
  client: FactoryClient | null,
  extra: Partial<Parameters<typeof createWorksetResolver>[0]> = {},
) {
  return createWorksetResolver({
    collectInventory: async () => ({
      companions: [{ path: companion, health: "ready", pairings: [] }],
    }),
    launchCompanion: companion,
    mateCommand: ["bun", "cli.mjs"],
    client: () => client,
    env: { MATE_FACTORY_REPOSITORIES: "https://git.acme.test/acme/web.git" },
    now: () => new Date("2026-10-29T12:00:00.000Z"),
    ...extra,
  });
}

const SESSION = "acme-session-0001";

describe("resolving a Workset session", () => {
  test("outside factory mode nothing starts", async () => {
    expect(await resolver(null)("acme-login", null, SESSION)).toEqual({
      reason: "Workset sessions need the appliance's factory mode",
    });
  });

  test("without a credential nothing is spawned", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const { client, calls } = fakeClient({ credential: null });
    const result = await resolver(client)("acme-login", null, SESSION);
    expect("reason" in result && result.reason).toContain("no Workset agent credential");
    expect(calls).toEqual([]);
  });

  test.each([
    [
      "an unknown Workset",
      "acme-other",
      "repositories: [acme/web]\n",
      /no valid Workset acme-other/,
    ],
    [
      "two repositories",
      "acme-login",
      "repositories: [acme/web, acme/api]\n",
      /names 2 repositories/,
    ],
    [
      "an unresolvable repository",
      "acme-login",
      "repositories: [acme/unknown]\n",
      /acme\/unknown is neither linked/,
    ],
  ])("refuses %s before spawning", async (_name, id, body, reason) => {
    record("acme-login", body);
    const { client, calls } = fakeClient();
    const result = await resolver(client)(id, null, SESSION);
    expect("reason" in result && result.reason).toMatch(reason);
    expect(calls).toEqual([]);
  });

  test("the first session spawns from the configured URL, links, and starts Clarify intent", async () => {
    record("acme-login", "title: Login with SSO\nrepositories: [acme/web]\n");
    const { client, calls } = fakeClient();
    const result = await resolver(client)("acme-login", null, SESSION);
    expect(calls[0]).toEqual([
      "spawn",
      {
        id: "acme-login",
        repository: "acme/web",
        remoteUrl: "https://git.acme.test/acme/web.git",
        companion,
      },
    ]);
    expect(calls[1]).toEqual([
      "exec",
      ["mate", "working", "link", "--companion", companion, "--yes"],
    ]);
    // Interactive Claude would otherwise open on its login screen.
    expect(calls[2]![1]).toEqual(["node", "-e", expect.stringContaining("hasCompletedOnboarding")]);
    // The wrap and the index run here, not in the terminal.
    expect(calls[3]![1]).toEqual(["mate", "claude", "--", "--yes", "--prepare-only"]);
    expect(result).toEqual({
      companionPath: companion,
      workset: { id: "acme-login", title: "Login with SSO" },
      argv: [
        "bun",
        "cli.mjs",
        "factory",
        "attach",
        "acme-login",
        "--session",
        SESSION,
        "--start",
        "clarify",
        "--companion",
        companion,
      ],
    });
  });

  test("the spawn's warnings open the terminal as a notice", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const warnings = [
      "workset/acme-api of acme-api looks squash-merged into the default branch; it is not inherited.",
      "Ticket ABC-1 does not name the branch.",
    ];
    const result = await resolver(fakeClient({ warnings }).client)("acme-login", null, SESSION);
    expect("notice" in result && result.notice).toBe(warnings.join("\r\n"));
  });

  test("a later session continues the conversation", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient({ conversation: true }).client)(
      "acme-login",
      null,
      SESSION,
    );
    expect("argv" in result && result.argv).toContain("continue");
  });

  test("Explore change starts once and records it, then continues", async () => {
    record("acme-login", "repositories: [acme/web]\nstage: explore\n");
    const { client } = fakeClient({ conversation: true });
    const first = await resolver(client)("acme-login", null, SESSION);
    expect("argv" in first && first.argv).toContain("explore");
    const saved = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(saved.exploreStartedAt).toBe("2026-10-29T12:00:00.000Z");
    const second = await resolver(client)("acme-login", null, SESSION);
    expect("argv" in second && second.argv).toContain("continue");
  });

  test("a failed link is shown and nothing is started", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient({ linkFails: true }).client)(
      "acme-login",
      null,
      SESSION,
    );
    expect(result).toEqual({ reason: "linking the worktree failed: acme link broke" });
  });

  test("the preparation's output is not in the terminal's argv or notice", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient().client)("acme-login", null, SESSION);
    expect(JSON.stringify(result)).not.toContain("wrapped");
    expect(JSON.stringify(result)).not.toContain("Syncing");
    expect("notice" in result).toBe(false);
    expect("argv" in result && result.argv).not.toContain("--prepare-only");
  });

  test("a failed preparation is refused with its first line and starts no terminal", async () => {
    record("acme-login", "repositories: [acme/web]\nstage: explore\n");
    const result = await resolver(fakeClient({ prepareFails: "acme wrap broke" }).client)(
      "acme-login",
      null,
      SESSION,
    );
    expect(result).toEqual({
      reason: "the Workset's session could not be prepared: acme wrap broke",
    });
    // Explore change is not recorded as started by a session that never opened.
    const saved = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(saved.exploreStartedAt).toBeUndefined();
  });

  test("the settings script trusts only the worktree it runs in and keeps every other key", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const { client, calls } = fakeClient();
    await resolver(client)("acme-login", null, SESSION);
    const script = (calls[2]![1] as string[])[2]!;

    const home = path.join(root, "home");
    const worktree = path.join(root, "worktree");
    fs.mkdirSync(home);
    fs.mkdirSync(worktree);
    const file = path.join(home, ".claude.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: "dark",
        projects: { "/elsewhere": { hasTrustDialogAccepted: false, allowedTools: ["Read"] } },
      }),
    );
    const run = () =>
      spawnSync("node", ["-e", script], { cwd: worktree, env: { ...process.env, HOME: home } });

    expect(run().status).toBe(0);
    const merged = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(merged).toEqual({
      theme: "dark",
      hasCompletedOnboarding: true,
      projects: {
        "/elsewhere": { hasTrustDialogAccepted: false, allowedTools: ["Read"] },
        [fs.realpathSync(worktree)]: { hasTrustDialogAccepted: true },
      },
    });
    // Already prepared: a second run changes nothing.
    const before = fs.readFileSync(file, "utf8");
    expect(run().status).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);

    // A blank file is empty config; a damaged one is kept beside it and replaced.
    fs.writeFileSync(file, "");
    expect(run().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).hasCompletedOnboarding).toBe(true);
    for (const damaged of ["{ truncated", "[1]"]) {
      for (const entry of fs.readdirSync(home)) {
        if (entry.includes(".damaged-")) fs.rmSync(path.join(home, entry));
      }
      fs.writeFileSync(file, damaged);
      const result = run();
      expect(result.status).toBe(0);
      expect(result.stderr.toString()).toContain("no JSON object");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).hasCompletedOnboarding).toBe(true);
      const kept = fs.readdirSync(home).filter((entry) => entry.includes(".damaged-"));
      expect(kept).toHaveLength(1);
      expect(fs.readFileSync(path.join(home, kept[0]!), "utf8")).toBe(damaged);
    }
  });

  test("a Studio without companion Git sync starts the session without it", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient().client, { noGit: true })(
      "acme-login",
      null,
      SESSION,
    );
    expect("argv" in result && result.argv.at(-1)).toBe("--no-git");
  });

  test("a person in control resumes the factory's own Claude session", async () => {
    record("acme-login", "repositories: [acme/web]\nstage: explore\n");
    const claudeSession = "2a41e812-a0fa-4908-a871-6df87d4ea2bc";
    const result = await resolver(fakeClient({ conversation: true }).client, {
      takenOver: async () => ({ claudeSession }),
    })("acme-login", null, SESSION);
    expect("argv" in result && result.argv.slice(-6)).toEqual([
      "--start",
      "resume",
      "--companion",
      companion,
      "--resume-session",
      claudeSession,
    ]);
    // Never a new conversation, and Explore change is not recorded as started.
    const saved = parse(
      fs.readFileSync(path.join(companion, "worksets", "acme-login.yaml"), "utf8"),
    );
    expect(saved.exploreStartedAt).toBeUndefined();
  });

  test("control without a saved conversation opens nothing", async () => {
    record("acme-login", "repositories: [acme/web]\n");
    const result = await resolver(fakeClient().client, {
      takenOver: async () => ({ claudeSession: null }),
    })("acme-login", null, SESSION);
    expect(result).toEqual({ reason: "this Outcome has no factory conversation to take over" });
  });
});
