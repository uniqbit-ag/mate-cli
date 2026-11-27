import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { frictionLogDir, readEvents } from "../runtime/friction-log";
import { writeFrictionSwitch } from "../runtime/friction-switch";
import { writeProjectionPair } from "../runtime/projection";
import { repoLocalRegistryPath } from "../runtime/repo-local";
import { evaluate } from "./validate-artifact-path";

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(recording: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mate-hook-friction-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  const companion = path.join(root, "companion");
  fs.mkdirSync(home);
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(companion, ".mate", "config"), { recursive: true });
  fs.writeFileSync(path.join(companion, ".mate", "config", "framework.yaml"), "capabilities: []\n");
  if (recording) writeFrictionSwitch(true, home);
  spawnSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
  const registryPath = repoLocalRegistryPath(repo);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, "companions: []\n");
  writeProjectionPair(repo, {
    stamp: "deadbeef",
    projection: {
      version: "0.0.0",
      companionPath: companion,
      repositoryPath: repo,
      repositoryId: "acme",
      wrapperBinPath: path.join(companion, "wrappers", "bin"),
      reactDoctorBinPath: path.join(companion, "react-doctor"),
    },
  });
  const run = (tool_name: string, tool_input: Record<string, unknown>) =>
    evaluate({ session_id: "s1", tool_name, tool_input }, { HOME: home }, repo);
  return { home, repo, companion, run };
}

const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

describe("the Claude guard records refusals as friction", () => {
  test("records one event per check, without a launch environment", async () => {
    const { home, repo, companion, run } = fixture(true);
    fs.writeFileSync(path.join(repo, ".env"), "API_KEY=supersecret\n");

    await run("Read", { file_path: path.join(repo, ".env") });
    await run("Bash", { command: `git commit -m "fix: x" -m "${TRAILER}"` });
    await run("Write", { file_path: path.join(repo, "notes.md"), content: "line one\nline two" });

    const events = readEvents({ sinceDays: 1, homeDir: home });
    expect(events.map((event) => event.fingerprint)).toEqual([
      "refusal:secret:read",
      "refusal:attribution:shell",
      "refusal:artifact:write",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({ runtime: "claude", sessionId: "s1", companion });
    }
    expect(events[0].detail).toEqual({ check: "secret", toolKind: "read" });
    expect(events[2].detail.paths).toEqual([path.join(repo, "notes.md")]);
    const log = JSON.stringify(events);
    expect(log).not.toContain(".env");
    expect(log).not.toContain("fix: x");
    expect(log).not.toContain("line one");
  });

  test("keeps the exit code and message, and adds the nudge line after it", async () => {
    const selected = fixture(true);
    const plain = fixture(false);
    const target = (repo: string) => ({ file_path: path.join(repo, "design.md") });

    const recorded = await selected.run("Write", target(selected.repo));
    const unrecorded = await plain.run("Write", target(plain.repo));

    expect(recorded.exitCode).toBe(2);
    expect(unrecorded.exitCode).toBe(2);
    const [event] = readEvents({ sinceDays: 1, homeDir: selected.home });
    const root = (repo: string) => path.dirname(repo);
    expect(recorded.stderr.replaceAll(root(selected.repo), "")).toBe(
      `${unrecorded.stderr.replaceAll(root(plain.repo), "")}Wrong or unclear? Run: mate friction report ${event.id} --kind <bug|unclear> --expected "<what you expected>". Then continue with your task.\n`,
    );
    expect(unrecorded.stderr).not.toContain("friction report");
    expect(fs.existsSync(frictionLogDir(plain.home))).toBe(false);
  });

  test("a repeated refusal gets no nudge line", async () => {
    const { repo, run } = fixture(true);
    const write = () => run("Write", { file_path: path.join(repo, "design.md") });

    expect((await write()).stderr).toContain("friction report");
    const second = await write();
    expect(second.exitCode).toBe(2);
    expect(second.stderr).not.toContain("friction report");
  });

  test("an allowed call records nothing", async () => {
    const { home, repo, run } = fixture(true);

    expect((await run("Write", { file_path: path.join(repo, "src", "index.ts") })).exitCode).toBe(
      0,
    );
    expect(fs.readdirSync(frictionLogDir(home))).toEqual(["settings.json"]);
  });
});
