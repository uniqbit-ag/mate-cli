// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import type { FrameworkConfig } from "../../../lib/orchestrator/types";
import { refreshFromTemplate } from "../plugins/guidance";
import { resolveGitInfoExcludePath } from "../git-utils";
import type { Plugin } from "../plugin";
import { pruneEmptyAncestors } from "../utils";
import { getSetupProvidersRoot, getSetupRootTemplates } from "./utils";

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

interface HooksDocument {
  description?: string;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const MANAGED_HOOK_MARKERS = [
  "/.codex/hooks/mate-session-banner",
  "/.codex/hooks/validate-artifact-path",
  "/.codex/hooks/react-doctor",
  "/.codex/hooks/mate-openspec-artifact-finish",
];

async function readHooks(filePath: string): Promise<HooksDocument> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
    return parsed as HooksDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(
      `Cannot reconcile Codex hooks at ${filePath}: the file is unreadable or invalid JSON. Repair it and retry Mate synchronization.`,
      { cause: error },
    );
  }
}

export async function reconcileCompanionCodexHookGroup(
  companionPath: string,
  event: string,
  marker: string,
  group?: HookGroup,
): Promise<void> {
  const hooksPath = getCompanionCodexHooksPath(companionPath);
  const document = await readHooks(hooksPath);
  const hooks = { ...document.hooks };
  const remaining = (hooks[event] ?? []).filter(
    (candidate) => !(candidate.hooks ?? []).some((hook) => hook.command?.includes(marker)),
  );
  if (group) remaining.unshift(group);
  if (remaining.length > 0) hooks[event] = remaining;
  else delete hooks[event];
  await fs.mkdir(path.dirname(hooksPath), { recursive: true });
  await fs.writeFile(hooksPath, JSON.stringify({ ...document, hooks }, null, 2) + "\n", "utf8");
}

function isManagedGroup(group: HookGroup): boolean {
  return (group.hooks ?? []).some((hook) =>
    MANAGED_HOOK_MARKERS.some((marker) => hook.command?.includes(marker)),
  );
}

function mergeManagedHooks(
  existing: HooksDocument,
  managed: Record<string, HookGroup[]>,
): HooksDocument {
  const hooks: Record<string, HookGroup[]> = {};
  const events = new Set([...Object.keys(existing.hooks ?? {}), ...Object.keys(managed)]);
  for (const event of events) {
    const unmanaged = (existing.hooks?.[event] ?? []).filter((group) => !isManagedGroup(group));
    const groups = [...(managed[event] ?? []), ...unmanaged];
    if (groups.length > 0) hooks[event] = groups;
  }
  return { ...existing, description: "Mate-managed Codex hooks.", hooks };
}

function baseHooks(companionPath: string): Record<string, HookGroup[]> {
  return {
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command: `node "${path.join(companionPath, ".codex", "hooks", "mate-session-banner.cjs")}"`,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash|exec_command|apply_patch|Edit|Write",
        hooks: [
          {
            type: "command",
            command: `node "${path.join(companionPath, ".codex", "hooks", "validate-artifact-path.cjs")}"`,
          },
        ],
      },
    ],
  };
}

export function getCompanionCodexHooksPath(companionPath: string): string {
  return path.join(companionPath, ".codex", "hooks.json");
}

async function configureCodex(companionPath: string): Promise<void> {
  const codexDir = path.join(companionPath, ".codex");
  const hooksDir = path.join(codexDir, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });
  await refreshFromTemplate(
    path.join(companionPath, "AGENTS.md"),
    path.join(getSetupRootTemplates(), "TEMPLATE_AGENTS.md"),
  );

  const codexHooks = path.join(getSetupProvidersRoot(), "codex", ".codex", "hooks");
  for (const name of ["mate-session-banner.cjs", "validate-artifact-path.cjs"]) {
    await fs.copyFile(path.join(codexHooks, name), path.join(hooksDir, name));
  }

  const hooksPath = getCompanionCodexHooksPath(companionPath);
  const hooks = mergeManagedHooks(await readHooks(hooksPath), baseHooks(companionPath));
  await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2) + "\n", "utf8");
}

interface RuntimeManifest {
  version: 2;
  companionPath: string;
  skillLinks: string[];
  hookCommands: string[];
  excludeEntries?: string[];
  hooksFileCreated?: boolean;
  hookOwnership: HookOwnership[];
}

interface HookOwnership {
  event: string;
  matcher: string;
  command: string;
  source: string;
  contentHash: string;
}

function manifestPath(workingRepoPath: string): string {
  return path.join(workingRepoPath, ".mate", "config", "codex-runtime.json");
}

async function readManifest(workingRepoPath: string): Promise<RuntimeManifest | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(manifestPath(workingRepoPath), "utf8"),
    ) as RuntimeManifest;
    return parsed.version === 2 ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Cannot read Codex runtime manifest at ${manifestPath(workingRepoPath)}. Repair or remove it and retry.`,
      { cause: error },
    );
  }
}

async function addExcludeEntries(workingRepoPath: string, entries: string[]): Promise<string[]> {
  const excludePath = await resolveGitInfoExcludePath(workingRepoPath);
  if (!excludePath) return [];
  let content = "";
  try {
    content = await fs.readFile(excludePath, "utf8");
  } catch {
    /* fresh repository */
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const added = entries.filter((entry) => !lines.includes(entry));
  lines.push(...added);
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, lines.join("\n") + "\n", "utf8");
  return added;
}

async function removeExcludeEntries(workingRepoPath: string, entries: string[]): Promise<void> {
  if (entries.length === 0) return;
  const excludePath = await resolveGitInfoExcludePath(workingRepoPath);
  if (!excludePath) return;
  try {
    const content = await fs.readFile(excludePath, "utf8");
    const owned = new Set(entries);
    const lines = content.split(/\r?\n/).filter((line) => line && !owned.has(line));
    await fs.writeFile(excludePath, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  } catch {
    /* absent */
  }
}

async function reconcileSkillLinks(
  workingRepoPath: string,
  companionPath: string,
  previous: RuntimeManifest | null,
): Promise<string[]> {
  const sourceRoot = path.join(companionPath, ".codex", "skills");
  const destRoot = path.join(workingRepoPath, ".agents", "skills");
  let names: string[] = [];
  try {
    names = (await fs.readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .toSorted();
  } catch {
    /* no skills */
  }

  const desired = new Set(names.map((name) => path.join(".agents", "skills", name)));
  for (const relativePath of previous?.skillLinks ?? []) {
    if (desired.has(relativePath)) continue;
    const dest = path.join(workingRepoPath, relativePath);
    try {
      const stat = await fs.lstat(dest);
      if (stat.isSymbolicLink()) await fs.unlink(dest);
    } catch {
      /* absent */
    }
  }

  if (names.length > 0) await fs.mkdir(destRoot, { recursive: true });
  for (const name of names) {
    const source = path.join(sourceRoot, name);
    const dest = path.join(destRoot, name);
    try {
      const stat = await fs.lstat(dest);
      if (!stat.isSymbolicLink()) {
        throw new Error(`Codex skill collision at ${dest}; move or rename the user-owned entry.`);
      }
      const target = await fs.readlink(dest);
      if (path.resolve(path.dirname(dest), target) === source) continue;
      const previousOwned = previous?.skillLinks.includes(path.join(".agents", "skills", name));
      if (!previousOwned) {
        throw new Error(`Codex skill collision at ${dest}; it points to a different source.`);
      }
      await fs.unlink(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.symlink(source, dest, process.platform === "win32" ? "junction" : "dir");
  }
  return [...desired];
}

function hookCommands(document: HooksDocument): string[] {
  return Object.values(document.hooks ?? {})
    .flat()
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command): command is string => !!command);
}

function hookGroupHash(group: HookGroup): string {
  return crypto.createHash("sha256").update(JSON.stringify(group)).digest("hex");
}

function hookCommandSource(command: string): string {
  return command.match(/["']([^"']+)["']/)?.[1] ?? command;
}

function isUnmodifiedOwnedGroup(
  event: string,
  group: HookGroup,
  previous: RuntimeManifest | null,
): boolean {
  const hash = hookGroupHash(group);
  return (previous?.hookOwnership ?? []).some(
    (item) =>
      item.event === event &&
      item.matcher === (group.matcher ?? "") &&
      item.contentHash === hash &&
      (group.hooks ?? []).some((hook) => hook.command === item.command),
  );
}

async function syncWorkingHooks(
  workingRepoPath: string,
  companionPath: string,
  previous: RuntimeManifest | null,
): Promise<{ commands: string[]; created: boolean; ownership: HookOwnership[] }> {
  const source = await readHooks(getCompanionCodexHooksPath(companionPath));
  const destPath = path.join(workingRepoPath, ".codex", "hooks.json");
  let created = false;
  try {
    await fs.access(destPath);
  } catch {
    created = true;
  }
  const existing = await readHooks(destPath);
  const hooks: Record<string, HookGroup[]> = {};
  const sourceHooks = source.hooks ?? {};
  const events = new Set([...Object.keys(existing.hooks ?? {}), ...Object.keys(sourceHooks)]);
  for (const event of events) {
    const sourceGroups = sourceHooks[event] ?? [];
    const preserved = (existing.hooks?.[event] ?? []).filter(
      (group) => !isUnmodifiedOwnedGroup(event, group, previous),
    );
    for (const managedGroup of sourceGroups) {
      const managedCommands = new Set((managedGroup.hooks ?? []).map((hook) => hook.command));
      const priorTargets = (previous?.hookOwnership ?? [])
        .filter((item) => item.event === event && item.matcher === (managedGroup.matcher ?? ""))
        .map((item) => item.source);
      const collision = preserved.find((group) =>
        (group.hooks ?? []).some(
          (hook) =>
            hook.command &&
            (managedCommands.has(hook.command) ||
              priorTargets.some((target) => hook.command?.includes(target))),
        ),
      );
      if (collision && JSON.stringify(collision) !== JSON.stringify(managedGroup)) {
        throw new Error(
          `Codex hook collision at ${destPath} -> hooks.${event}: a Mate-managed hook was modified. Restore or remove it, then retry.`,
        );
      }
    }
    const equivalent = new Set(sourceGroups.map((group) => JSON.stringify(group)));
    const groups = [
      ...sourceGroups,
      ...preserved.filter((group) => !equivalent.has(JSON.stringify(group))),
    ];
    if (groups.length > 0) hooks[event] = groups;
  }
  const next = { ...existing, description: "Mate-managed Codex hooks.", hooks };
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  const ownership = Object.entries(sourceHooks).flatMap(([event, groups]) =>
    groups.flatMap((group) =>
      (group.hooks ?? []).flatMap((hook) =>
        hook.command
          ? [
              {
                event,
                matcher: group.matcher ?? "",
                command: hook.command,
                source: hookCommandSource(hook.command),
                contentHash: hookGroupHash(group),
              },
            ]
          : [],
      ),
    ),
  );
  return { commands: hookCommands(source), created, ownership };
}

async function removeWorkingHooks(
  workingRepoPath: string,
  previous: RuntimeManifest | null,
): Promise<void> {
  if (!previous) return;
  const destPath = path.join(workingRepoPath, ".codex", "hooks.json");
  const existing = await readHooks(destPath);
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(existing.hooks ?? {})) {
    const preserved = groups.filter((group) => !isUnmodifiedOwnedGroup(event, group, previous));
    if (preserved.length > 0) hooks[event] = preserved;
  }
  const hasOtherContent = Object.keys(existing).some(
    (key) => key !== "hooks" && key !== "description",
  );
  if (Object.keys(hooks).length === 0 && !hasOtherContent && previous.hooksFileCreated) {
    await fs.rm(destPath, { force: true });
    await pruneEmptyAncestors(path.dirname(destPath), workingRepoPath);
    return;
  }
  const next: HooksDocument = { ...existing, hooks };
  if (next.description === "Mate-managed Codex hooks.") delete next.description;
  if (Object.keys(hooks).length === 0) delete next.hooks;
  await fs.writeFile(destPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

export async function syncWorkingRepoCodexState(
  workingRepoPath: string,
  companionPath: string,
  config: FrameworkConfig,
): Promise<void> {
  const enabled = (config.profiles.default?.allowedAgents ?? []).includes("codex");
  const previous = await readManifest(workingRepoPath);
  if (!enabled) {
    await reconcileSkillLinks(workingRepoPath, path.join(companionPath, ".disabled"), previous);
    await removeWorkingHooks(workingRepoPath, previous);
    await removeExcludeEntries(workingRepoPath, previous?.excludeEntries ?? []);
    await fs.rm(manifestPath(workingRepoPath), { force: true });
    await pruneEmptyAncestors(path.dirname(manifestPath(workingRepoPath)), workingRepoPath);
    return;
  }

  const skillLinks = await reconcileSkillLinks(workingRepoPath, companionPath, previous);
  const workingHooks = await syncWorkingHooks(workingRepoPath, companionPath, previous);
  const desiredExcludes = [
    ...skillLinks,
    ...(workingHooks.created ? [path.join(".codex", "hooks.json")] : []),
  ];
  const retainedExcludes = (previous?.excludeEntries ?? []).filter((entry) =>
    desiredExcludes.includes(entry),
  );
  await removeExcludeEntries(
    workingRepoPath,
    (previous?.excludeEntries ?? []).filter((entry) => !desiredExcludes.includes(entry)),
  );
  const addedExcludes = await addExcludeEntries(workingRepoPath, desiredExcludes);
  const manifest: RuntimeManifest = {
    version: 2,
    companionPath,
    skillLinks,
    hookCommands: workingHooks.commands,
    excludeEntries: [...new Set([...retainedExcludes, ...addedExcludes])],
    hooksFileCreated: previous?.hooksFileCreated ?? workingHooks.created,
    hookOwnership: workingHooks.ownership,
  };
  await fs.mkdir(path.dirname(manifestPath(workingRepoPath)), { recursive: true });
  await fs.writeFile(manifestPath(workingRepoPath), JSON.stringify(manifest, null, 2) + "\n");
}

async function teardownCodex(companionPath: string, _config: FrameworkConfig): Promise<void> {
  await fs.rm(path.join(companionPath, ".codex"), { recursive: true, force: true });
  await pruneEmptyAncestors(path.join(companionPath, ".codex"), companionPath);
}

export const codexPlugin: Plugin = {
  id: "codex",
  kind: "provider",
  label: "Codex",
  description: "Install Codex companion skills, hooks, and guidance.",
  defaultSelected: false,
  isEnabled: (config) => (config.profiles.default?.allowedAgents ?? []).includes("codex"),
  async apply(ctx) {
    await configureCodex(ctx.companionPath);
  },
  async teardown(ctx) {
    await teardownCodex(ctx.companionPath, ctx.config);
  },
};
