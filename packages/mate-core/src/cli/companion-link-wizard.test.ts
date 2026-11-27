import { describe, expect, test } from "bun:test";

import {
  selectCompanionLinkInputs,
  type CompanionLinkWizardOptions,
} from "./companion-link-wizard";
import { createTtyInput, createTtyOutput } from "../../test/helpers";

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function startWizard(options: Omit<CompanionLinkWizardOptions, "stdin" | "stdout" | "stderr">) {
  const stdin = createTtyInput();
  const stdout = createTtyOutput();
  let screen = "";
  stdout.on("data", (chunk) => {
    screen += String(chunk);
  });
  const result = selectCompanionLinkInputs({
    ...options,
    stdin,
    stdout,
    stderr: createTtyOutput(),
  });
  return { stdin, result, screen: () => screen };
}

describe("selectCompanionLinkInputs", () => {
  test("selects local and captures a pasted path", async () => {
    const localPath = "/tmp/companion repo";
    const wizard = startWizard({
      existingCompanions: [{ path: "/tmp/managed-companion", registered: true }],
    });

    await tick(50);
    wizard.stdin.write("\u001b[B");
    wizard.stdin.write("\u001b[B");
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write(localPath);
    wizard.stdin.write("\r");

    await expect(wizard.result).resolves.toEqual({ source: "local", localPath, replace: true });
  });

  // Under CI, Ink prints only the frame shown at unmount; `q` ends the wizard on the step a test reads.
  test("lists existing, git, local in that order", async () => {
    const wizard = startWizard({
      existingCompanions: [{ path: "/work/acme-companion", registered: true }],
    });

    await tick(50);
    wizard.stdin.write("q");
    await expect(wizard.result).resolves.toBeNull();
    const order = [
      "Use a companion already on this machine",
      "Clone from a Git URL into ~/.mate/companions",
      "Enter the path of another folder",
    ].map((label) => wizard.screen().indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("preselects existing and marks unregistered companions", async () => {
    const existingCompanions = [
      { path: "/work/acme-companion", registered: true },
      { path: "/work/acme-docs", registered: false },
    ];
    const marked = startWizard({ existingCompanions });
    await tick(50);
    marked.stdin.write("\r");
    await tick();
    marked.stdin.write("q");
    await marked.result;
    expect(marked.screen()).toContain("(not registered) /work/acme-docs");

    const wizard = startWizard({ existingCompanions });
    await tick(50);
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("\r");

    await expect(wizard.result).resolves.toEqual({
      source: "existing",
      companionPaths: ["/work/acme-companion"],
      replace: true,
    });
  });

  test("preselects git when no companion is on this machine", async () => {
    const wizard = startWizard({ existingCompanions: [] });

    await tick(50);
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("https://example.com/acme/acme-companion.git");
    wizard.stdin.write("\r");

    await expect(wizard.result).resolves.toEqual({
      source: "git",
      gitUrl: "https://example.com/acme/acme-companion.git",
      replace: true,
    });
  });

  test("offers a matching clone, preselected, before cloning a new copy", async () => {
    const wizard = startWizard({
      existingCompanions: [],
      clonesOf: (url) => (url.includes("acme-companion") ? ["/work/acme-companion"] : []),
    });

    await tick(50);
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("https://example.com/acme/acme-companion.git");
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("\r");

    await expect(wizard.result).resolves.toEqual({
      source: "git",
      gitUrl: "https://example.com/acme/acme-companion.git",
      clonePath: "/work/acme-companion",
      replace: true,
    });
    expect(wizard.screen()).toContain("Use the clone at /work/acme-companion");
    expect(wizard.screen()).toContain("Clone a new copy");
  });

  test("asks replace or keep both, Replace preselected and naming the old companion", async () => {
    const wizard = startWizard({
      existingCompanions: [{ path: "/work/new-companion", registered: true }],
      replacedBy: (inputs) =>
        inputs.companionPaths?.includes("/work/new-companion") ? ["/work/old-companion"] : [],
    });

    await tick(50);
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("\r");
    await tick();
    wizard.stdin.write("\r");

    await expect(wizard.result).resolves.toEqual({
      source: "existing",
      companionPaths: ["/work/new-companion"],
      replace: true,
    });
    expect(wizard.screen()).toContain("Replace old-companion");
    expect(wizard.screen()).not.toContain("Replace /work/");
    expect(wizard.screen()).toContain("Keep both");
  });
});
