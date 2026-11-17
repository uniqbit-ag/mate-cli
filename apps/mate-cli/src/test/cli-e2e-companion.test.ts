/** @test-requires sockets */

import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse, stringify } from "yaml";

import {
  DEFAULT_TEST_TIMEOUT_MS,
  createScenario,
  installCompanion,
  linkRepository,
  pathWithoutCommand,
  readJson,
  runMate,
  setupCompanion,
  waitForFile,
  workspaceDocument,
  writeEditorStub,
  removeScenarios,
} from "./cli-e2e-support";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);

describe("mate CLI e2e: companion setup and open", () => {
  test("companion setup delegates to the linked companion repository", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-guard-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "setup", "--allowed-agent", "claude"],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("inside linked working repo `app`");

    const framework = parse(
      await fs.readFile(path.join(scenario.working, ".mate", "config", "framework.yaml"), "utf8"),
    ) as { type?: string };
    expect(framework.type).toBe("working");
  });

  test("linked no-flag setup requires a TTY for the interactive picker", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-linked-no-tty-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "setup"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Interactive setup selection requires a TTY.");
    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: openspec");
  });

  test("linked non-capability-flag setup preserves companion capabilities and managed files", async () => {
    const scenario = await createScenario("mate-cli-e2e-setup-preserve-linked-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    await fs.access(path.join(scenario.companion, ".claude", "skills", "mate-explore-change"));
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "setup", "--allowed-agent", "claude"],
    });

    expect(result.exitCode).toBe(0);
    const config = await fs.readFile(
      path.join(scenario.companion, ".mate", "config", "framework.yaml"),
      "utf8",
    );
    expect(config).toContain("name: openspec");
    await fs.access(path.join(scenario.companion, ".claude", "skills", "mate-explore-change"));
  });

  test("claude fails when run from companion directory with no linked working repository", async () => {
    const scenario = await createScenario("mate-cli-e2e-launch-no-repo-");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await installCompanion(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.companion,
      args: ["claude", "--"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "mate: launch must be run from a working repository directory.",
    );
    expect(result.stderr).toContain("mate companion link");
  });

  test("companion open opens the workspace file in code", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-");
    const capturePath = await writeEditorStub(scenario, "code");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: { MATE_E2E_EDITOR_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);

    await waitForFile(capturePath);
    const invocation = await readJson<{ cwd: string; argv: string[] }>(capturePath);
    expect(invocation.cwd).toBe(scenario.working);
    expect(invocation.argv).toEqual([workspaceDocument(scenario)]);
    expect(await readJson(workspaceDocument(scenario))).toEqual({
      folders: [{ path: scenario.working }, { path: scenario.companion }],
      settings: { "git.detectWorktrees": true, "scm.alwaysShowRepositories": true },
    });
  });

  test("companion open renames a legacy workspace file and opens it", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-legacy-");
    const capturePath = await writeEditorStub(scenario, "code");
    const legacyPath = path.join(scenario.working, ".mate", "workspace.code-workspace");
    const extraPath = path.join(scenario.root, "acme-extra");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `{\n  // acme\n  "folders": [{ "path": "${extraPath}" }],\n}\n`,
      "utf8",
    );

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: { MATE_E2E_EDITOR_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `Workspace: opened .mate/${path.basename(scenario.working)}.mate.code-workspace in the editor`,
    );
    await waitForFile(capturePath);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([workspaceDocument(scenario)]);
    expect(await fs.stat(legacyPath).catch(() => null)).toBeNull();
    const text = await fs.readFile(workspaceDocument(scenario), "utf8");
    expect(text).toContain("// acme");
    expect(text).toContain(extraPath);
  });

  test("companion open leaves a broken workspace file alone and spawns no editor", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-broken-");
    const capturePath = await writeEditorStub(scenario, "code");
    const workspacePath = workspaceDocument(scenario);

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, '{ "folders": [', "utf8");

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: { MATE_E2E_EDITOR_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`mate: warning: ${workspacePath}: invalid JSONC:`);
    expect(await fs.readFile(workspacePath, "utf8")).toBe('{ "folders": [');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await fs.stat(capturePath).catch(() => null)).toBeNull();
  });

  test("companion open adds every Linked Companion without a TTY", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-many-");
    const capturePath = await writeEditorStub(scenario, "code");

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    // A copy of the companion already lists the working repo in its registry;
    // pointing the repo-local registry at it too makes the link ambiguous.
    const secondCompanion = `${scenario.companion}-b`;
    await fs.cp(scenario.companion, secondCompanion, { recursive: true });
    const registryPath = path.join(scenario.working, ".mate", "config", "registry.yaml");
    const registry = parse(await fs.readFile(registryPath, "utf8")) as {
      companions: Array<{ path: string }>;
    };
    registry.companions.push({ ...registry.companions[0]!, path: secondCompanion });
    await fs.writeFile(registryPath, stringify(registry), "utf8");

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: { MATE_E2E_EDITOR_CAPTURE_PATH: capturePath },
    });

    expect(result.exitCode).toBe(0);

    await waitForFile(capturePath);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([workspaceDocument(scenario)]);
    expect(
      (await readJson<{ folders: Array<{ path: string }> }>(workspaceDocument(scenario))).folders,
    ).toEqual([
      { path: scenario.working },
      { path: scenario.companion },
      { path: secondCompanion },
    ]);
  });

  test("companion open falls back to code-insiders when code is unavailable", async () => {
    const scenario = await createScenario("mate-cli-e2e-workspace-open-insiders-");
    const capturePath = await writeEditorStub(scenario, "code-insiders");
    /** Stripping `code` from PATH may drop bun's dir too; stubs need bun via their shebang. */
    await fs.symlink(process.execPath, path.join(scenario.bin, "bun"));

    expect((await setupCompanion(scenario)).exitCode).toBe(0);
    expect((await linkRepository(scenario)).exitCode).toBe(0);

    const result = await runMate(scenario, {
      cwd: scenario.working,
      args: ["companion", "open"],
      env: {
        PATH: `${scenario.bin}:${pathWithoutCommand("code", process.env.PATH ?? "")}`,
        MATE_E2E_EDITOR_CAPTURE_PATH: capturePath,
      },
    });

    expect(result.exitCode).toBe(0);

    await waitForFile(capturePath);
    const invocation = await readJson<{ argv: string[] }>(capturePath);
    expect(invocation.argv).toEqual([workspaceDocument(scenario)]);
  });
});
