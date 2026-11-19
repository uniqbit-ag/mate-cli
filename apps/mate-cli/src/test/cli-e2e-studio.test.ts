/** @test-requires sockets */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import {
  APP_ROOT,
  DEFAULT_TEST_TIMEOUT_MS,
  type E2EScenario,
  createScenario,
  escapeRegex,
  openSpecStubEnv,
  setupCompanion,
  waitForFile,
  removeScenarios,
} from "./cli-e2e-support";
import { lockStudioDist, unlockStudioDist } from "./studio-dist-lock";

setDefaultTimeout(DEFAULT_TEST_TIMEOUT_MS);
afterEach(removeScenarios);
// The packaging tests rebuild the Studio app these tests serve.
beforeAll(lockStudioDist, 180_000);
afterAll(unlockStudioDist);

/**
 * Stubs the platform browser launchers on the scenario PATH; no real browser
 * may open during a test run.
 */
async function writeBrowserStub(scenario: E2EScenario): Promise<string> {
  const capturePath = path.join(scenario.root, "browser-capture.txt");
  const source = ["#!/usr/bin/env bash", `printf '%s\\n' "$@" >> ${capturePath}`, ""].join("\n");
  for (const name of ["open", "xdg-open"]) {
    const stubPath = path.join(scenario.bin, name);
    await fs.writeFile(stubPath, source, "utf8");
    await fs.chmod(stubPath, 0o755);
  }
  return capturePath;
}

interface StudioProcess {
  url: string;
  browserCapturePath: string;
  stderr: () => string;
  stop: (signal: NodeJS.Signals) => Promise<number>;
}

/**
 * Starts `mate studio` and resolves once it has reported its URL. The child is
 * a foreground server, so it is driven by signal rather than awaited to exit.
 */
async function startStudio(scenario: E2EScenario, cwd: string): Promise<StudioProcess> {
  const browserCapturePath = await writeBrowserStub(scenario);
  const child = spawn(process.execPath, [path.join(APP_ROOT, "src/cli.ts"), "studio"], {
    cwd,
    env: {
      ...process.env,
      HOME: scenario.home,
      PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
      ...openSpecStubEnv(scenario),
      CI: "",
      MATE_ARTIFACT_PATH: "",
      MATE_VERSION: "",
      MATE_REPO_ID: "",
      MATE_REPO_PATH: "",
      MATE_POLICY_JSON: "",
      MATE_DISABLE_OPENCODE_PLUGIN_PREFETCH: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  const deadline = Date.now() + 20_000;
  let url: string | undefined;
  while (Date.now() < deadline && url === undefined) {
    url = stdout.match(/http:\/\/localhost:\d+/)?.[0];
    if (url === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (url === undefined) {
    child.kill("SIGKILL");
    throw new Error(
      `studio never reported a URL\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  return {
    url,
    browserCapturePath,
    stderr: () => stderr,
    stop: async (signal) => {
      child.kill(signal);
      return exited;
    },
  };
}

/**
 * The digest the served companion list hands out for a companion path, read from
 * the page's data. Studio addresses a companion by digest, so the page is the
 * only place a URL for one can be read from.
 */
function companionDigestFrom(markup: string, companionPath: string): string {
  const match = markup.match(
    new RegExp(`digest:"([0-9a-f]+)",path:"${escapeRegex(companionPath)}"`),
  );
  if (!match?.[1]) throw new Error(`no companion option for ${companionPath}`);
  return match[1];
}

async function listPaths(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return found.sort();
}

describe("mate studio e2e", () => {
  test("serves the document at the reported URL", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      const document = await fetch(studio.url);
      expect(document.status).toBe(200);
      expect(document.headers.get("content-type")).toContain("text/html");

      const markup = await document.text();
      expect(markup.toLowerCase()).toContain("<!doctype html>");
      expect(markup).toContain("Mate Studio");
      expect(markup).toContain('aria-label="Companion Repositories"');
      expect(markup).not.toContain('id="studio-companion"');
      expect(markup).toContain(scenario.companion);
      /** Nothing is named, so no companion state is assembled. */
      expect(markup).toContain(">Choose a Companion Repository</h1>");
      expect(markup).not.toContain("add-acme-checkout");
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("a URL naming a companion renders that companion's state", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-url-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      const digest = companionDigestFrom(
        await (await fetch(studio.url)).text(),
        scenario.companion,
      );

      const dashboard = await fetch(`${studio.url}/?companion=${digest}`);
      expect(dashboard.status).toBe(200);
      /** Views render in the browser; the first response carries each view's data. */
      const dashboardMarkup = await dashboard.text();
      expect(dashboardMarkup).toContain(">Overview</h1>");
      expect(dashboardMarkup).toContain(`["${digest}","view","dashboard"`);
      expect(dashboardMarkup).toContain('name:"add-acme-checkout"');
      expect(dashboardMarkup).not.toContain("Choose a Companion Repository");

      /** Areas are their own view, read apart from the changes. */
      const specs = await fetch(`${studio.url}/specs?companion=${digest}`);
      expect(specs.status).toBe(200);
      const specsMarkup = await specs.text();
      expect(specsMarkup).toContain(">Specs</h1>");
      expect(specsMarkup).toContain(`["${digest}","view","specs"`);
      expect(specsMarkup).toContain('capability:"acme-checkout"');
      expect(specsMarkup).not.toContain('name:"add-acme-checkout"');

      const workflow = await fetch(`${studio.url}/workflow?companion=${digest}`);
      expect(workflow.status).toBe(200);
      const workflowMarkup = await workflow.text();
      expect(workflowMarkup).toContain(">Workflow</h1>");
      expect(workflowMarkup).toContain(`["${digest}","view","workflow"`);
      expect(workflowMarkup).toContain('schemaName:"mate-v1"');
      expect(workflowMarkup).not.toContain('name:"add-acme-checkout"');
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("a URL naming no registered companion renders the selector", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-unknown-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      const response = await fetch(`${studio.url}/?companion=deadbeef00`);
      expect(response.status).toBe(200);

      const markup = await response.text();
      expect(markup).toContain('aria-label="Companion Repositories"');
      expect(markup).toContain(scenario.companion);
      expect(markup).toContain(">Choose a Companion Repository</h1>");
      expect(markup).not.toContain("Could not read this companion");
      /** The picker stands in for the view, so no view data is loaded. */
      expect(markup).not.toContain('["deadbeef00","view","dashboard"');
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("the removed JSON endpoints answer as unrouted", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-endpoints-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      for (const route of [
        "/api/inventory",
        `/api/companion?path=${encodeURIComponent(scenario.companion)}`,
      ]) {
        const response = await fetch(`${studio.url}${route}`);
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type") ?? "").not.toContain("application/json");
        expect((await response.text()).trimStart()).not.toMatch(/^[[{]/);
      }
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("opens the platform browser at the served URL", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-browser-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      await waitForFile(studio.browserCapturePath, 10_000);
      expect(await fs.readFile(studio.browserCapturePath, "utf8")).toContain(studio.url);
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("refuses a write method", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-readonly-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const studio = await startStudio(scenario, scenario.root);
    try {
      const response = await fetch(studio.url, { method: "POST" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    } finally {
      await studio.stop("SIGINT");
    }
  });

  test("an interrupt ends the server and leaves no process or state behind", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-lifecycle-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const before = await listPaths(scenario.home);
    const studio = await startStudio(scenario, scenario.root);
    expect((await fetch(studio.url)).status).toBe(200);

    await studio.stop("SIGINT");

    await expect(fetch(studio.url)).rejects.toThrow();
    expect(await listPaths(scenario.home)).toEqual(before);
    expect(studio.stderr()).not.toContain("could not bind");
  });

  test("runs from a directory that is not a working repository", async () => {
    const scenario = await createScenario("mate-cli-e2e-studio-anywhere-");
    expect((await setupCompanion(scenario)).exitCode).toBe(0);

    const outside = path.join(scenario.root, "outside");
    await fs.mkdir(outside, { recursive: true });

    const studio = await startStudio(scenario, outside);
    try {
      expect((await fetch(studio.url)).status).toBe(200);
      expect(studio.stderr()).not.toContain("not linked");
    } finally {
      await studio.stop("SIGINT");
    }
  });
});

describe("openspec wrapper e2e", () => {
  const WRAPPER = path.resolve(APP_ROOT, "../../packages/mate-core/wrappers/bin/openspec");

  /** Runs the shipped wrapper on the real bundled CLI: no preload, a decoy first on PATH. */
  function runWrapper(scenario: E2EScenario, cwd: string, args: string[]) {
    const decoy = path.join(scenario.bin, "openspec");
    return spawnSync(WRAPPER, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: scenario.home,
        XDG_CONFIG_HOME: path.join(scenario.home, ".config"),
        XDG_DATA_HOME: path.join(scenario.home, ".local", "share"),
        PATH: `${scenario.bin}:${process.env.PATH ?? ""}`,
        CI: "1",
        BUN_OPTIONS: "",
        MATE_E2E_OPENSPEC_BIN: decoy,
        MATE_ARTIFACT_PATH: scenario.companion,
        MATE_REPO_PATH: "",
        MATE_REPO_ID: "",
        MATE_VERSION: "",
        MATE_POLICY_JSON: "",
      },
    });
  }

  test("runs the pinned bundled CLI in the companion, never a decoy or the former override", async () => {
    const scenario = await createScenario("mate-cli-e2e-openspec-wrapper-");
    await fs.writeFile(
      path.join(scenario.bin, "openspec"),
      '#!/bin/sh\necho "9.9.9-decoy"\n',
      "utf8",
    );
    await fs.chmod(path.join(scenario.bin, "openspec"), 0o755);
    const corePackage = JSON.parse(
      await fs.readFile(path.resolve(path.dirname(WRAPPER), "../../package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };

    const versionRun = runWrapper(scenario, scenario.root, ["--version"]);
    expect(versionRun.stderr).toBe("");
    expect(versionRun.stdout.trim()).toBe(corePackage.dependencies["@fission-ai/openspec"]);

    const init = runWrapper(scenario, scenario.root, ["init", "--tools", "none", "--no-animation"]);
    expect(init.status).toBe(0);

    const nested = path.join(scenario.companion, "acme");
    await fs.mkdir(nested);
    const list = runWrapper(scenario, nested, ["list", "--json"]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).root.path).toBe(scenario.companion);
  });
});
