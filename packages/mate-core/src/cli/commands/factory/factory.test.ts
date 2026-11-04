import { describe, expect, test } from "bun:test";

import { parseAttachArgs, parseServeArgs } from "./factory";

const SESSION = "2a41e812-a0fa-4908-a871-6df87d4ea2bc";

describe("mate factory attach arguments", () => {
  test("a resume start names the Claude session; --no-git may sit anywhere", () => {
    expect(
      parseAttachArgs([
        "acme-login",
        "--session",
        "s1",
        "--no-git",
        "--start",
        "resume",
        "--companion",
        "/companions/acme",
        "--resume-session",
        SESSION,
      ]),
    ).toEqual({
      id: "acme-login",
      session: "s1",
      start: "resume",
      companion: "/companions/acme",
      noGit: true,
      resumeSession: SESSION,
    });
  });

  test("a resume session goes only with a resume start, and only as a session id", () => {
    const base = ["acme-login", "--session", "s1", "--companion", "/companions/acme"];
    expect(parseAttachArgs([...base, "--start", "resume"])).toEqual({
      error: "--resume-session goes with --start resume, and only with it",
    });
    expect(parseAttachArgs([...base, "--resume-session", SESSION])).toEqual({
      error: "--resume-session goes with --start resume, and only with it",
    });
    expect(
      parseAttachArgs([...base, "--start", "resume", "--resume-session", "--continue"]),
    ).toEqual({ error: "--resume-session is not a Claude session id" });
    expect(parseAttachArgs([...base, "--yolo"])).toEqual({ error: "unknown option --yolo" });
  });
});

describe("mate factory serve arguments", () => {
  const base = [
    "--socket",
    "/run/acme/broker.sock",
    "--docker-host",
    "unix:///run/acme/docker.sock",
    "--state-dir",
    "/var/lib/acme",
    "--image",
    "mate-workset:1.0.0-acme",
    "--user",
    "mate",
    "--companions-dir",
    "/companions",
  ];

  test("the Workset resource limits are optional", () => {
    expect(parseServeArgs(base)).toEqual({
      socket: "/run/acme/broker.sock",
      "docker-host": "unix:///run/acme/docker.sock",
      "state-dir": "/var/lib/acme",
      image: "mate-workset:1.0.0-acme",
      user: "mate",
      "companions-dir": "/companions",
    });
  });

  test("reads the cap, idle minutes, memory, pids and cpus", () => {
    expect(
      parseServeArgs([
        ...base,
        "--max-worksets",
        "4",
        "--idle-minutes",
        "0",
        "--memory",
        "4G",
        "--pids",
        "1024",
        "--cpus",
        "1.5",
      ]),
    ).toMatchObject({ maxWorksets: 4, idleMinutes: 0, memory: "4g", pids: 1024, cpus: "1.5" });
  });

  test("reads the agent stages' memory beside the full one", () => {
    expect(parseServeArgs([...base, "--memory", "4g", "--agent-memory", "1536M"])).toMatchObject({
      memory: "4g",
      agentMemory: "1536m",
    });
  });

  test.each([
    [["--max-worksets", "0"], "--max-worksets"],
    [["--idle-minutes", "-1"], "--idle-minutes"],
    [["--memory", "lots"], "--memory"],
    [["--memory", "4g", "--pids", "x"], "--pids"],
    [["--memory", "4g", "--cpus", "0"], "--cpus"],
    [["--pids", "10"], "go with --memory"],
    [["--agent-memory", "1g"], "go with --memory"],
    [["--memory", "4g", "--agent-memory", "lots"], "--agent-memory"],
  ])("refuses %j", (extra, message) => {
    const parsed = parseServeArgs([...base, ...extra]);
    expect("error" in parsed && parsed.error).toContain(message);
  });
});
