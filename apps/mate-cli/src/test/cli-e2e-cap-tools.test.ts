/** @test-requires sockets */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  linkRepository,
  readJson,
  runMate,
  setupCompanion,
  writeOpenSpecStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: capability passthrough", () => {
  test("cap openspec runs openspec from the companion root", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "update", "--force"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    // The first command in the Working Repository registers the companion's store.
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ["store", "register", scenario.companion, "--id", "app", "--yes"],
      ["config", "reset", "--all", "-y"],
      ["update", "--force"],
    ]);
    expect(invocations.every((invocation) => invocation.cwd === scenario.companion)).toBe(true);
  });

  test("cap openspec injects companion schema for templates when absent", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-templates-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario, [], { capabilities: ["openspec"] })).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "templates", "--json"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    const templates = invocations.filter((invocation) => invocation.args[0] !== "store");
    expect(templates).toHaveLength(1);
    expect(templates[0]?.cwd).toBe(scenario.companion);
    expect(templates[0]?.args).toEqual(["templates", "--schema", "mate-full", "--json"]);
  });

  test("cap openspec preserves explicit schema for templates", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-openspec-templates-explicit-");
    const capturePath = await writeOpenSpecStub(scenario);

    expect((await setupCompanion(scenario, [], { capabilities: ["openspec"] })).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "openspec", "templates", "--schema", "spec-driven", "--json"],
      env: { MATE_E2E_OPENSPEC_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocations = await readJson<Array<{ cwd: string; args: string[] }>>(capturePath);
    const templates = invocations.filter((invocation) => invocation.args[0] !== "store");
    expect(templates).toHaveLength(1);
    expect(templates[0]?.args).toEqual(["templates", "--schema", "spec-driven", "--json"]);
  });

  test("top-level openspec command is rejected", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-alias-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["openspec", "update"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown command: openspec");
  });
});
