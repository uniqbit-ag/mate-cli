import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTempDir, overrideEnv } from "../../../../../test/fixtures";
import { collectDoctorReport } from "../../cli/commands/doctor";
import { resetActiveDistribution, setActiveDistribution } from "../../distribution";
import { appendEvent, appendReport } from "../../runtime/friction-log";
import { PluginRegistry } from "../../tools/setup/registry";
import { getTriagePlaybookPath } from "../package-paths";
import { markFriction } from "../friction/mark";
import { writeFrictionSnapshot } from "./context";
import { prepareTriageSession } from "./prepare";
import { triageRoot } from "./session";

const now = new Date("2027-03-14T12:00:00.000Z");
const roots: string[] = [];

async function fixture() {
  const root = await createTempDir("mate-triage-prepare-");
  roots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "acme");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const claude = path.join(bin, "claude");
  fs.writeFileSync(claude, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  return { root, home, bin, cwd };
}

function useDistribution(issueRepository?: string) {
  setActiveDistribution({
    config: { runtime: "bun", version: "1.2.3", issueRepository },
    registry: new PluginRegistry([]),
  });
}

function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  collectDoctor: (cwd: string) => Promise<unknown> = async (cwd) => ({ kind: "core", cwd }),
  target?: string,
) {
  return prepareTriageSession({
    argv: target ? [target, "--no-launch"] : ["--no-launch"],
    cwd: f.cwd,
    homeDir: f.home,
    now,
    pathValue: f.bin,
    env: process.env,
    collectDoctor,
    target,
  });
}

function event(
  companion: string,
  at: Date,
  home = companion,
  detail: Record<string, unknown> = {},
  fingerprint = "refusal:artifact:write",
) {
  appendEvent(
    {
      kind: "refusal",
      fingerprint,
      mateVersion: "1.2.3",
      runtime: "claude",
      sessionId: "s1",
      companion,
      repositoryPath: null,
      detail,
    },
    { homeDir: home, now: at },
  );
}

const inCompanion = (companionPath: string) => async (cwd: string) => ({ cwd, companionPath });

beforeEach(() => useDistribution("acme/mate"));

afterEach(() => {
  resetActiveDistribution();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prepareTriageSession", () => {
  test("writes the machine facts, the doctor report and the issue repository", async () => {
    const f = await fixture();

    const { files } = await prepare(f);
    const context = fs.readFileSync(files.context, "utf8");

    expect(context).toContain("version: 1.2.3");
    expect(context).toContain("triage --no-launch");
    expect(context).toContain(`(${process.platform}, ${process.arch})`);
    expect(context).toContain("JavaScript runtime: Bun");
    expect(context).toContain(`9.9.9 (Claude Code), at ${path.join(f.bin, "claude")}`);
    expect(context).toContain("OpenCode (`opencode`): not found");
    expect(context).toContain(`Folder the command ran in: ${f.cwd}`);
    expect(context).toContain("Issue repository: acme/mate");
    expect(context).toContain(`"cwd": "${f.cwd}"`);
  });

  test("records a failing doctor in place of its report", async () => {
    const f = await fixture();

    const { files } = await prepare(f, async () => {
      throw new Error("acme doctor failure");
    });

    expect(fs.readFileSync(files.context, "utf8")).toContain(
      "The doctor report could not be built: acme doctor failure",
    );
  });

  test("says that no issue repository is set when the distribution names none", async () => {
    useDistribution(undefined);
    const f = await fixture();

    const { files } = await prepare(f);

    expect(fs.readFileSync(files.context, "utf8")).toContain("Issue repository: none set");
  });

  test("copies no MATE_GIT_TOKEN value into the session", async () => {
    const f = await fixture();
    const secret = "acme-token-4f9c2b7e";
    const restore = overrideEnv({ MATE_GIT_TOKEN: secret, HOME: f.home });
    try {
      const { files } = await prepare(f, (cwd) => collectDoctorReport({ cwd }));
      for (const name of fs.readdirSync(files.dir)) {
        expect(fs.readFileSync(path.join(files.dir, name), "utf8")).not.toContain(secret);
      }
    } finally {
      restore();
    }
  });

  test("masks a secret that a doctor error echoes", async () => {
    const f = await fixture();
    const restore = overrideEnv({ ACME_API_TOKEN: "acme-token-7d1e" });
    try {
      const { files } = await prepare(f, async () => {
        throw new Error("plugin config rejected acme-token-7d1e");
      });
      const context = fs.readFileSync(files.context, "utf8");
      expect(context).toContain("plugin config rejected ***");
      expect(context).not.toContain("acme-token-7d1e");
    } finally {
      restore();
    }
  });

  test("masks a secret that the doctor report holds JSON-escaped", async () => {
    const f = await fixture();
    const secret = 'acme"pass\\7d1e';
    const restore = overrideEnv({ ACME_PASSWORD: secret });
    try {
      const { files } = await prepare(f, async () => ({ failure: `rejected ${secret}` }));
      const context = fs.readFileSync(files.context, "utf8");
      expect(context).toContain('"failure": "rejected ***"');
      expect(context).not.toContain(JSON.stringify(secret).slice(1, -1));
    } finally {
      restore();
    }
  });

  test("copies the last 30 days of friction and names the files", async () => {
    const f = await fixture();
    event(f.home, new Date("2027-03-10T00:00:00Z"));
    event(f.home, new Date("2027-01-20T00:00:00Z"));
    event(path.join(f.root, "other-companion"), new Date("2027-03-10T00:00:00Z"), f.home);
    appendReport(
      {
        eventId: null,
        kind: "unclear",
        cost: "detour",
        subject: "acme refusal",
        expected: "a hint",
        evidence: null,
        workaround: null,
        mateVersion: "1.2.3",
        companion: f.home,
        sessionId: null,
        runtime: null,
      },
      { homeDir: f.home, now: new Date("2027-03-11T00:00:00Z") },
    );

    const { files } = await prepare(f, inCompanion(f.home));
    const events = fs.readFileSync(path.join(files.dir, "friction-events.jsonl"), "utf8");
    const reports = fs.readFileSync(path.join(files.dir, "friction-reports.jsonl"), "utf8");
    const context = fs.readFileSync(files.context, "utf8");

    expect(events.trim().split("\n")).toHaveLength(1);
    expect(reports).toContain("acme refusal");
    expect(context).toContain("`friction-events.jsonl`: 1 Friction Event");
    expect(context).toContain("`friction-reports.jsonl`: 1 agent report");
  });

  test("copies no friction outside a companion and says where to run", async () => {
    const f = await fixture();
    event(f.home, new Date("2027-03-10T00:00:00Z"));

    const { files } = await prepare(f);

    expect(fs.existsSync(path.join(files.dir, "friction-events.jsonl"))).toBe(false);
    expect(fs.readFileSync(files.context, "utf8")).toContain("run `mate triage` in the affected");
  });

  test("withholds the evidence of an event the scanner flags", async () => {
    const f = await fixture();
    const at = new Date("2027-03-10T00:00:00Z");
    event(f.home, at, f.home, { message: "clean" });
    event(f.home, at, f.home, {
      message: "flagged",
      command: "flagged",
      paths: ["flagged"],
      flags: ["--flagged"],
    });
    const dir = path.join(f.root, "session");
    fs.mkdirSync(dir);

    await writeFrictionSnapshot(dir, {
      companion: f.home,
      homeDir: f.home,
      now,
      scan: async (file) => [{ path: file, line: 2, ruleId: "acme-rule" }],
    });

    const [clean, flagged] = fs
      .readFileSync(path.join(dir, "friction-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).detail);
    expect(clean).toEqual({ message: "clean" });
    expect(flagged).toEqual({
      message: "[withheld: acme-rule]",
      command: "[withheld: acme-rule]",
      paths: "[withheld: acme-rule]",
      flags: "[withheld: acme-rule]",
    });
  });

  test("withholds every event's evidence when the scanner fails", async () => {
    const f = await fixture();
    event(f.home, new Date("2027-03-10T00:00:00Z"), f.home, { errorText: "clean" });
    const dir = path.join(f.root, "session");
    fs.mkdirSync(dir);

    await writeFrictionSnapshot(dir, {
      companion: f.home,
      homeDir: f.home,
      now,
      scan: async () => {
        throw new Error("engine failed");
      },
    });

    expect(fs.readFileSync(path.join(dir, "friction-events.jsonl"), "utf8")).toContain(
      '"errorText":"[withheld: scan-failed]"',
    );
  });

  test("copies every event and the Friction States of the copied fingerprints", async () => {
    const f = await fixture();
    const at = new Date("2027-03-10T00:00:00Z");
    event(f.home, at);
    appendEvent(
      {
        kind: "refusal",
        fingerprint: "refusal:secret:read",
        mateVersion: "1.2.3",
        runtime: "claude",
        sessionId: "s1",
        companion: f.home,
        repositoryPath: null,
        detail: {},
      },
      { homeDir: f.home, now: at },
    );
    const link = "https://github.com/acme/mate/issues/7";
    await markFriction(
      "refusal:artifact:write",
      "reported",
      { by: "person", link },
      {
        homeDir: f.home,
        now: new Date(at.getTime() - 1),
      },
    );

    const { files } = await prepare(f, inCompanion(f.home));

    const events = fs.readFileSync(path.join(files.dir, "friction-events.jsonl"), "utf8");
    expect(events.trim().split("\n")).toHaveLength(2);
    const states = JSON.parse(
      fs.readFileSync(path.join(files.dir, "friction-states.json"), "utf8"),
    );
    expect(Object.keys(states.fingerprints)).toEqual(["refusal:artifact:write"]);
    expect(states.fingerprints["refusal:artifact:write"]).toMatchObject({
      state: "reported",
      link,
      eventsSince: 1,
      reopened: false,
    });
    expect(states.reports).toEqual({});
    expect(fs.readFileSync(files.context, "utf8")).toContain(
      "`friction-states.json`: 1 Friction State",
    );
  });

  test("writes an empty friction-states.json when nothing is marked", async () => {
    const f = await fixture();
    event(f.home, new Date("2027-03-10T00:00:00Z"));

    const { files } = await prepare(f, inCompanion(f.home));

    expect(
      JSON.parse(fs.readFileSync(path.join(files.dir, "friction-states.json"), "utf8")),
    ).toEqual({
      v: 1,
      fingerprints: {},
      reports: {},
    });
  });

  test("writes no friction file without recorded friction", async () => {
    const f = await fixture();

    const { files } = await prepare(f, inCompanion(f.home));

    expect(fs.readdirSync(files.dir).toSorted()).toEqual([
      "PLAYBOOK.md",
      "context.md",
      "prompt.md",
    ]);
    expect(fs.readFileSync(files.context, "utf8")).toContain("No friction was recorded");
  });

  describe("with a Triage Target", () => {
    const fingerprint = "refusal:artifact:write";
    const recent = new Date("2027-03-10T00:00:00Z");

    function companions(f: Awaited<ReturnType<typeof fixture>>) {
      const acme = path.join(f.root, "acme-companion");
      const beta = path.join(f.root, "beta-companion");
      fs.mkdirSync(acme);
      fs.mkdirSync(beta);
      return { acme, beta };
    }

    const prepareTarget = (f: Awaited<ReturnType<typeof fixture>>, current: string | null) =>
      prepare(f, current ? inCompanion(current) : async (cwd) => ({ cwd }), fingerprint);

    const copiedEvents = (dir: string) =>
      fs
        .readFileSync(path.join(dir, "friction-events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const copiedCompanions = (dir: string) => copiedEvents(dir).map((copied) => copied.companion);

    test("copies the current companion's friction when it holds the target", async () => {
      const f = await fixture();
      const { acme, beta } = companions(f);
      event(acme, recent, f.home);
      event(beta, recent, f.home);

      const { files } = await prepareTarget(f, acme);

      const context = fs.readFileSync(files.context, "utf8");

      expect(copiedCompanions(files.dir)).toEqual([acme]);
      expect(context).not.toContain("The snapshot holds");
      expect(context).toContain(`other companions, not copied here: ${beta} (1).`);
    });

    test("copies the target's only companion and notes the mismatch", async () => {
      const f = await fixture();
      const { acme, beta } = companions(f);
      event(acme, recent, f.home);
      event(beta, recent, f.home, {}, "refusal:secret:read");

      const { files } = await prepareTarget(f, beta);
      const context = fs.readFileSync(files.context, "utf8");

      expect(copiedCompanions(files.dir)).toEqual([acme]);
      expect(context).toContain(`Triage Target: \`${fingerprint}\`, a fingerprint`);
      expect(context).toContain(`friction of companion ${acme}`);
      expect(context).toContain(`belongs to companion ${beta}; the doctor report describes`);
    });

    test("refuses a target of several other companions and writes no session", async () => {
      const f = await fixture();
      const { acme, beta } = companions(f);
      event(acme, recent, f.home);
      event(beta, recent, f.home);

      const refused = prepareTarget(f, null);

      await expect(refused).rejects.toThrow(`${acme}, ${beta}`);
      expect(fs.existsSync(triageRoot(f.home))).toBe(false);
    });

    test("copies a 45-day-old target but no other event older than 30 days", async () => {
      const f = await fixture();
      const { acme } = companions(f);
      event(acme, new Date("2027-01-28T00:00:00Z"), f.home);
      event(acme, new Date("2027-01-28T00:00:00Z"), f.home, {}, "refusal:secret:read");
      event(acme, new Date("2027-03-09T00:00:00Z"), f.home, {}, "refusal:secret:read");

      const { files } = await prepareTarget(f, acme);
      const fingerprints = copiedEvents(files.dir).map(
        (copied) => `${copied.fingerprint} ${copied.at.slice(0, 10)}`,
      );

      expect(fingerprints).toEqual([
        "refusal:artifact:write 2027-01-28",
        "refusal:secret:read 2027-03-09",
      ]);
    });
  });

  test("copies the shipped playbook and names it and the context file in the prompt", async () => {
    const f = await fixture();

    const { files } = await prepare(f);
    const prompt = fs.readFileSync(files.prompt, "utf8");

    expect(fs.readFileSync(files.playbook, "utf8")).toBe(
      fs.readFileSync(getTriagePlaybookPath(), "utf8"),
    );
    expect(prompt).toContain("PLAYBOOK.md");
    expect(prompt).toContain("context.md");
  });
});
