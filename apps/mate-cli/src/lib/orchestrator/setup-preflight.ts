import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { frameworkConfig } from "../../framework";
import { fileExists } from "../fs-utils";
import { GlobalConfigStore } from "./global-config-store";
import { CompanionResolver, type CompanionMatch } from "./companion-resolver";

export type SetupPreflightResult =
  | { kind: "existing-companion" }
  | { kind: "unrecognized" }
  | {
      kind: "linked-working-repo";
      match: CompanionMatch;
      ambiguousMatches: CompanionMatch[];
    };

// Strong file markers: any single one is enough.
const STRONG_FILE_MARKERS = [
  // Non-JS language manifests
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  // Non-JS lock files — impossible in a JS/TS companion repo
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  // Monorepo / workspace tooling — never present in a plain companion repo
  "turbo.json",
  "nx.json",
  "lerna.json",
  "pnpm-workspace.yaml",
  "rush.json",
];

// Weak file markers: JS/TS things that a companion repo could also have.
// Two or more together trigger.
const WEAK_FILE_MARKERS = [
  ".git",
  "package.json",
  "Makefile",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "pnpm-lock.yaml",
];

// JS/TS frameworks whose presence in package.json deps is a strong signal.
const FRAMEWORK_PACKAGES = new Set([
  // Frontend frameworks
  "react",
  "vue",
  "@angular/core",
  "svelte",
  "solid-js",
  "preact",
  // Meta-frameworks
  "next",
  "nuxt",
  "gatsby",
  "@remix-run/react",
  "@remix-run/node",
  "astro",
  "@builder.io/qwik",
  // Backend frameworks
  "express",
  "fastify",
  "koa",
  "@hapi/hapi",
  "@nestjs/core",
  "hono",
  "elysia",
  // Mobile / desktop
  "react-native",
  "expo",
  "electron",
]);

async function hasFrameworkDeps(cwd: string): Promise<boolean> {
  const pkgPath = path.join(cwd, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    return allDeps.some((dep) => FRAMEWORK_PACKAGES.has(dep));
  } catch {
    return false;
  }
}

export async function looksLikeWorkingRepo(cwd: string): Promise<boolean> {
  const resolvedCwd = path.resolve(cwd);

  for (const marker of STRONG_FILE_MARKERS) {
    if (await fileExists(path.join(resolvedCwd, marker))) {
      return true;
    }
  }

  if (await hasFrameworkDeps(resolvedCwd)) {
    return true;
  }

  let weakCount = 0;
  for (const marker of WEAK_FILE_MARKERS) {
    if (await fileExists(path.join(resolvedCwd, marker))) {
      weakCount++;
      if (weakCount >= 2) return true;
    }
  }

  return false;
}

export async function hasLocalCompanionConfig(cwd: string): Promise<boolean> {
  const resolvedCwd = path.resolve(cwd);
  const candidatePaths = [
    path.join(resolvedCwd, `.${frameworkConfig.name}`, "config", "framework.yaml"),
    ...frameworkConfig.legacyNames.map((name) =>
      path.join(resolvedCwd, `.${name}`, "config", "framework.yaml"),
    ),
  ];

  for (const candidatePath of candidatePaths) {
    if (await fileExists(candidatePath)) {
      return true;
    }
  }

  return false;
}

async function hasWorkingRepoConfig(cwd: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(path.resolve(cwd), `.${frameworkConfig.name}`, "config", "framework.yaml"),
      "utf8",
    );
    const config = parse(raw) as { type?: unknown } | null;
    return config?.type === "working";
  } catch {
    return false;
  }
}

export async function inspectSetupPreflight(
  cwd: string,
  globalConfigStore = new GlobalConfigStore(),
): Promise<SetupPreflightResult> {
  const resolvedCwd = path.resolve(cwd);
  const companions = await globalConfigStore.list();
  const isRegisteredCompanion = companions.some((c) => path.resolve(c) === resolvedCwd);

  // A directory explicitly registered as a companion is never classified as a
  // linked working repo, even if it sits inside another repo's working tree.
  // A stale registration of a working repo is the exception: its local type
  // marker is authoritative and must not make setup load working-repo config
  // as a companion profile config.
  if (isRegisteredCompanion && !(await hasWorkingRepoConfig(resolvedCwd))) {
    return { kind: "existing-companion" };
  }

  const resolution = await new CompanionResolver(globalConfigStore).resolveWithDiagnostics(cwd);
  if (resolution.match) {
    return {
      kind: "linked-working-repo",
      match: resolution.match,
      ambiguousMatches: resolution.ambiguousMatches,
    };
  }

  if (await hasLocalCompanionConfig(cwd)) {
    return { kind: "existing-companion" };
  }

  return { kind: "unrecognized" };
}

export function formatSetupGuardrailError(cwd: string, match: CompanionMatch): string {
  return [
    `\`${frameworkConfig.name} setup\` cannot run here: ${path.resolve(cwd)} is inside linked working repo \`${match.repositoryId}\`.`,
    `Run \`${frameworkConfig.name} setup\` from the companion repo instead: ${match.companionPath}`,
  ].join("\n");
}
