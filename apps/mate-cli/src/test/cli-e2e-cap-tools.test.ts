/** @test-requires sockets */

import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  GRAPHIFY_SECRET_EXCLUDE_ARGS,
  createScenario,
  linkRepository,
  readJson,
  runMate,
  setupCompanion,
  writeGraphifyStub,
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
    expect(templates[0]?.args).toEqual(["templates", "--schema", "mate-v1", "--json"]);
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

  test("cap graphify build routes through extract with companion-managed output", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-build-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", "build", "--mode", "deep"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{
      cwd: string;
      argv: string[];
      env: Record<string, string | null>;
    }>(capturePath);
    expect(invocation.cwd).toBe(scenario.working);
    expect(invocation.argv[0]).toBe("extract");
    expect(invocation.argv[1]).toBe(scenario.working);
    expect(invocation.argv).toContain("--out");
    expect(invocation.argv).toContain(path.join(scenario.companion, ".graphify", "app"));
    expect(invocation.argv.slice(-26)).toEqual(["--mode", "deep", ...GRAPHIFY_SECRET_EXCLUDE_ARGS]);
  });

  test("cap graphify query appends the shared graph path when no graph is provided", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-query-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", "query", "symbol:Mate"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([
      "query",
      "symbol:Mate",
      "--graph",
      path.join(scenario.companion, ".graphify", "app", "graphify-out", "graph.json"),
    ]);
  });

  test("cap graphify passes through path-first --update form", async () => {
    const scenario = await createScenario("mate-cli-e2e-cap-graphify-update-");
    const capturePath = await writeGraphifyStub(scenario);

    expect(
      (
        await setupCompanion(scenario, [], {
          allowedAgents: ["claude"],
          capabilities: ["graphify"],
        })
      ).exitCode,
    ).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["cap", "graphify", scenario.working, "--update", "--force"],
      env: { MATE_E2E_GRAPHIFY_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([
      scenario.working,
      "--update",
      "--force",
      ...GRAPHIFY_SECRET_EXCLUDE_ARGS,
    ]);
  });
});
