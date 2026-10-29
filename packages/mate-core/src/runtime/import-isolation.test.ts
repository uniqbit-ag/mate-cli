import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const SRC_ROOT = path.resolve(import.meta.dirname, "..");

const IMPORT_PATTERN =
  /(?:import|export)[^"']*from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectTransitiveModules(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const resolved = resolveModule(file, specifier);
      if (resolved) queue.push(resolved);
    }
  }
  return seen;
}

function relative(files: Iterable<string>): string[] {
  return [...files].map((file) => path.relative(SRC_ROOT, file));
}

describe("runtime subpath import isolation", () => {
  test("./runtime modules never import the rest of core", () => {
    const modules = collectTransitiveModules(path.join(SRC_ROOT, "runtime", "index.ts"));
    const outside = relative(modules).filter((file) => !file.startsWith("runtime/"));
    expect(outside).toEqual([]);
  });

  test("./hooks modules import ./runtime and nothing else from core", () => {
    const hooksDir = path.join(SRC_ROOT, "hooks");
    const modules = new Set<string>();
    for (const entry of fs.readdirSync(hooksDir)) {
      if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) continue;
      for (const module of collectTransitiveModules(path.join(hooksDir, entry))) {
        modules.add(module);
      }
    }
    const outside = relative(modules).filter(
      (file) => !file.startsWith("hooks/") && !file.startsWith("runtime/"),
    );
    expect(outside).toEqual([]);
  });

  test("./opencode modules stay on the session-runtime side of core", () => {
    const modules = collectTransitiveModules(path.join(SRC_ROOT, "opencode", "index.ts"));
    const outside = relative(modules).filter(
      (file) => !file.startsWith("opencode/") && !file.startsWith("runtime/"),
    );
    expect(outside).toEqual([]);
  });
});

/**
 * The session surfaces take their companion from Session Resolution only: a
 * module that walks to a projection or reads the launch variables itself
 * would skip the trust check (ADR-025). Writing the variables for a child
 * process stays allowed.
 */
const COMPANION_CHOICES = [
  /\bresolveProjection\b/g,
  /\bhasLaunchEnvironment\b/g,
  /\bMATE_ENV\.(?:companionPath|repositoryPath|repositoryId)\b(?!\s*\]\s*=[^=])/g,
  /(?:\.|\[\s*["'])(?:MATE_ARTIFACT_PATH|MATE_REPO_PATH|MATE_REPO_ID)\b(?:["']\s*\])?(?!\s*=[^=])/g,
];

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

/** The lines of `source` that choose a companion; `delete` of a variable is not a read. */
function companionChoices(source: string): string[] {
  return withoutComments(source)
    .split("\n")
    .filter((line) => !/^\s*delete\s/.test(line))
    .filter((line) => COMPANION_CHOICES.some((pattern) => line.match(pattern)));
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [file] : [];
  });
}

describe("session surfaces choose no companion themselves", () => {
  test("flags a projection walk or a launch variable read, but not a write", () => {
    expect(companionChoices("const found = resolveProjection(cwd);")).toHaveLength(1);
    expect(companionChoices("if (hasLaunchEnvironment(env)) return;")).toHaveLength(1);
    expect(companionChoices("const id = env[MATE_ENV.repositoryId] ?? '';")).toHaveLength(1);
    expect(companionChoices('const p = env.MATE_ARTIFACT_PATH ?? "";')).toHaveLength(1);
    expect(companionChoices('const p = env["MATE_REPO_PATH"];')).toHaveLength(1);
    expect(companionChoices("if (env.MATE_REPO_ID === id) return;")).toHaveLength(1);

    expect(companionChoices("env.MATE_ARTIFACT_PATH = context.companionPath;")).toEqual([]);
    expect(companionChoices("env[MATE_ENV.repositoryPath] = context.repositoryPath;")).toEqual([]);
    expect(companionChoices("  delete env.MATE_REPO_ID;")).toEqual([]);
    expect(companionChoices('text.replaceAll("$MATE_REPO_PATH", root);')).toEqual([]);
    expect(companionChoices("/** Unlike resolveProjection, this checks trust. */")).toEqual([]);
  });

  test("no hook or OpenCode module walks to a projection or reads the launch variables", () => {
    const dirs = [
      path.join(SRC_ROOT, "hooks"),
      path.join(SRC_ROOT, "opencode"),
      path.join(SRC_ROOT, "..", "opencode-plugin", "src"),
    ];
    const offenders = dirs
      .flatMap(sourceFiles)
      .flatMap((file) =>
        companionChoices(fs.readFileSync(file, "utf8")).map(
          (line) => `${path.relative(SRC_ROOT, file)}: ${line.trim()}`,
        ),
      );

    expect(offenders).toEqual([]);
  });
});
