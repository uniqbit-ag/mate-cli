import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import { compileGuides } from "./guide-content";

const sources = {
  start: { source: "## Start", path: "acme/start.md", title: "Start" },
  worktrees: {
    source: "## Setup\n\n[editor](/docs/getting-started/vscode#install)",
    path: "acme/worktrees.mdx",
    title: "Worktrees",
  },
  vscode: { source: "## Install", path: "acme/vscode.mdx", title: "Editor" },
};

describe("guide catalog", () => {
  test("compiles the actual canonical sources without a second prose copy", async () => {
    const worktrees = await readFile(
      new URL("../../../../apps/docs/content/docs/concepts/worktrees.mdx", import.meta.url),
      "utf8",
    );
    const vscode = await readFile(
      new URL("../../../../apps/docs/content/docs/getting-started/vscode.mdx", import.meta.url),
      "utf8",
    );
    const start = await readFile(
      new URL("../views/getting-started/start.md", import.meta.url),
      "utf8",
    );
    const compiled = compileGuides({
      worktrees: { ...sources.worktrees, source: worktrees },
      vscode: { ...sources.vscode, source: vscode },
      start: { ...sources.start, source: start },
    });
    expect(JSON.stringify(compiled)).toContain("working worktree");
    expect(JSON.stringify(compiled)).not.toContain("md-frontmatter");
  });

  test("source edits reach the compiled reader", () => {
    const changed = compileGuides({
      ...sources,
      vscode: { ...sources.vscode, source: "## Install\n\nacme-new-instruction" },
    });
    expect(JSON.stringify(changed.vscode)).toContain("acme-new-instruction");
  });

  test("reports broken topic and fragment links at their source", () => {
    expect(() =>
      compileGuides({ ...sources, vscode: { ...sources.vscode, source: "## Renamed" } }),
    ).toThrow("acme/worktrees.mdx: unresolved guide target");
    expect(() =>
      compileGuides({
        ...sources,
        worktrees: { ...sources.worktrees, source: "[broken](/docs/missing)" },
      }),
    ).toThrow("acme/worktrees.mdx: unresolved");
  });

  test("rejects unsupported markup instead of dropping it", () => {
    expect(() =>
      compileGuides({ ...sources, start: { ...sources.start, source: "<Acme />" } }),
    ).toThrow("acme/start.md: unsupported");
  });
});
