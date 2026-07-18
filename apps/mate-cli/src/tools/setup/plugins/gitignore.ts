import type { Plugin, SetupContext } from "../plugin";

const MANAGED_START = (name: string) => `# ${name} managed: start`;
const MANAGED_END = (name: string) => `# ${name} managed: end`;

// Legacy per-feature markers — stripped on next sync so old files self-heal
const LEGACY_MARKERS: [string, string][] = [
  ["# mate managed: uv start", "# mate managed: uv end"],
  ["# mate managed: headroom start", "# mate managed: headroom end"],
];

function stripManagedBlock(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  if (startIndex === -1) return content;

  const endIndex = content.indexOf(end, startIndex);
  const blockEnd = endIndex === -1 ? content.length : endIndex + end.length;
  const before = content.slice(0, startIndex).trimEnd();
  const after = content.slice(blockEnd).trimStart();
  const merged = [before, after].filter(Boolean).join("\n\n");
  return merged ? `${merged}\n` : "";
}

export async function writeManagedGitignoreBlock(
  gitignorePath: string,
  frameworkName: string,
  entries: string[],
): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");

  const start = MANAGED_START(frameworkName);
  const end = MANAGED_END(frameworkName);

  let existing = "";
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    /* absent is fine */
  }

  let content = stripManagedBlock(existing, start, end);
  for (const [s, e] of LEGACY_MARKERS) {
    content = stripManagedBlock(content, s, e);
  }

  if (entries.length > 0) {
    const block = [start, ...entries, end].join("\n");
    content = content.trimEnd() ? `${content.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }

  if (content !== existing) {
    await writeFile(gitignorePath, content, "utf8");
  }
}

export function collectManagedGitignoreEntries(ctx: SetupContext, plugins: Plugin[]): string[] {
  return plugins
    .filter((p) => p.kind !== "root" && (p.isEnabled(ctx.config) || p.persistGitignoreEntries))
    .flatMap((p) => p.gitignoreEntries?.(ctx) ?? []);
}

export function createGitignorePlugin(frameworkName: string, allPlugins: () => Plugin[]): Plugin {
  return {
    id: "gitignore",
    kind: "root",
    label: "Gitignore",
    description: "Maintain the managed gitignore block from all active plugin contributions.",
    defaultSelected: true,
    isEnabled: () => true,
    async apply(ctx: SetupContext) {
      const { join } = await import("node:path");
      const entries = collectManagedGitignoreEntries(ctx, allPlugins());

      await writeManagedGitignoreBlock(
        join(ctx.companionPath, ".gitignore"),
        frameworkName,
        entries,
      );
    },
    async teardown(ctx: SetupContext) {
      const { join } = await import("node:path");
      await writeManagedGitignoreBlock(join(ctx.companionPath, ".gitignore"), frameworkName, []);
    },
  };
}
