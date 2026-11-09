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
  test("keeps the former repository-page umbrella link readable", () => {
    const compiled = compileGuides({
      start: {
        ...sources.start,
        source: "[Umbrella Repository](/docs/concepts/repositories#umbrella-repository)",
      },
    });
    expect(JSON.stringify(compiled.start)).toContain(
      "/docs/concepts/repositories/#umbrella-repository",
    );
  });
  test("compiles Studio-owned summaries without public documentation sources", async () => {
    const worktrees = await readFile(
      new URL("../views/getting-started/worktrees.md", import.meta.url),
      "utf8",
    );
    const vscode = await readFile(
      new URL("../views/getting-started/vscode.md", import.meta.url),
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
    expect(start).toContain("mate companion link");
    expect(worktrees).toContain("open another terminal");
    expect(worktrees).toContain("Workset becomes Done");
    expect(worktrees).toContain("Dirty, locked, unpushed, or currently used");
    expect(worktrees).toContain("does not delete the branch or close your terminals");
    expect(worktrees).not.toMatch(/```|\bmate\s+[a-z]|`[^`]+`/);
    expect(vscode).toContain("mate vscode setup");
    expect(vscode).toContain("Only sidebar-started sessions");
    expect(vscode).toContain("**Open changes**");
    for (const source of [start, worktrees, vscode]) {
      expect(source.split(/\s+/).length).toBeLessThan(450);
    }
    const imports = await readFile(new URL("./guides.server.ts", import.meta.url), "utf8");
    expect(imports).not.toContain("apps/docs");
    for (const topic of ["start", "worktrees", "vscode"]) {
      expect(imports).toContain(`../views/getting-started/${topic}.md?raw`);
    }
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
