/** @test-requires sockets */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  installCompanion,
  removeScenarios,
  runMate,
  setupCompanion,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS * 2);
afterEach(removeScenarios);

/** Your own terminal: no Agent Runtime session id, whatever session runs the tests. */
const person = { CLAUDE_CODE_SESSION_ID: "", OPENCODE_SESSION_ID: "" };

describe("mate CLI e2e: friction", () => {
  test("a person turns recording on, an agent's failure is recorded and reported, off stops reports", async () => {
    const scenario = await createScenario("mate-cli-e2e-machine-switch-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);
    const agent = {
      ...person,
      CLAUDE_CODE_SESSION_ID: "s1",
      MATE_ARTIFACT_PATH: scenario.companion,
    };
    const mate = (args: string[], env: NodeJS.ProcessEnv, cwd = scenario.companion) =>
      runMate(scenario, { cwd, args, env });
    const recording = async () =>
      JSON.parse((await mate(["friction", "status", "--json"], agent)).stdout).recording;

    expect((await mate(["friction", "on"], agent)).exitCode).toBe(1);
    expect(await recording()).toBe(false);
    const on = await mate(["friction", "on"], person, scenario.root);
    expect(on.exitCode).toBe(0);
    expect(await recording()).toBe(true);

    const failed = await mate(["companion", "bogus"], agent);
    expect(failed.exitCode).not.toBe(0);
    const eventId = /Run: mate friction report (\S+) --kind/.exec(failed.stderr)?.[1];
    expect(eventId).toBeDefined();

    const report = await mate(
      ["friction", "report", eventId!, "--kind", "unclear", "--expected", "a list of subcommands"],
      agent,
    );
    expect(report.exitCode).toBe(0);
    const list = JSON.parse((await mate(["friction", "list", "--json"], person)).stdout);
    expect(list).toMatchObject({ kind: "friction-list", events: 1 });
    expect(list.groups[0].reports).toMatchObject([{ eventId, expected: "a list of subcommands" }]);

    expect((await mate(["friction", "off"], person)).exitCode).toBe(0);
    const refused = await mate(
      ["friction", "report", eventId!, "--kind", "bug", "--expected", "x", "--json"],
      agent,
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.code).toBe("recording-off");
    expect((await mate(["friction", "list"], person)).stdout).toContain("recording is off");
  });
});
