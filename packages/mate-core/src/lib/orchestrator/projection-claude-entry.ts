import fs from "node:fs/promises";
import path from "node:path";

import { TOKENSAVE_CLAUDE_MD_MARKER } from "../../tools/setup/capabilities/tokensave-shared";
import { cutFromMarker } from "../../tools/setup/providers/agent-file-sections";
import {
  filterClaudeHookGroups,
  isManagedHookGroup,
  removeManagedHookGroups,
  serializeClaudeSettings,
  type ClaudeSettings,
} from "../../tools/setup/providers/claude-format";
import { isMateGuardHookGroup } from "../../tools/setup/providers/claude-plugin-hooks";
import { repoDestination } from "../../runtime/repo-destination";
import { CLAUDE_SETTINGS_DOCUMENT } from "../../runtime/runtime-document-manifest";
import { readWrapState, type WrapState } from "../../runtime/wrap-state";
import { writeAtomic } from "../../runtime/write-atomic";
import { pruneEmptyAncestors } from "../../tools/setup/utils";
import { GlobalConfigStore } from "./global-config-store";
import {
  removalWithWarnings,
  type ProjectionRemovalReport,
  type ProjectionWriteReport,
} from "./projection-types";

/**
 * The working-repo half of the Claude Runtime Surface, as one Managed Projection
 * entry. Depends on the Claude settings *format* only: it never reaches back
 * into the provider, so a second Agent Runtime writing the same destination adds
 * a sibling module rather than a branch here.
 */

export const CLAUDE_WORKING_SETTINGS_PATH = path.join(".claude", "settings.local.json");
export const LEGACY_TOKENSAVE_CLAUDE_MD_PATH = "CLAUDE.md";

/** Inside the repository with no symlinked `.claude`, or the warning that refuses it. */
function settingsPath(repoPath: string): { path: string; root: string } | { warning: string } {
  return repoDestination(repoPath, CLAUDE_SETTINGS_DOCUMENT);
}

/** A symlinked `CLAUDE.md` is another file's, the user's global one included: read as absent. */
async function readClaudeMd(repoPath: string): Promise<{ path: string; content: string } | null> {
  const destination = repoDestination(repoPath, LEGACY_TOKENSAVE_CLAUDE_MD_PATH);
  if ("warning" in destination) return null;
  const stat = await fs.lstat(destination.path).catch(() => null);
  if (!stat?.isFile()) return null;
  const content = await readRaw(destination.path);
  return content === null ? null : { path: destination.path, content };
}

async function readRaw(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseSettings(raw: string | null): ClaudeSettings {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ClaudeSettings;
  } catch {
    /* unparseable — start from an empty object */
  }
  return {};
}

/**
 * Strips the managed hook groups earlier releases wrote here, but leaves every
 * group the `wrap` scope places: those are owned by the wrap's own entry —
 * Capability groups match a managed marker too — and stripping them would
 * disarm every Unmanaged Session on the next launch.
 */
function withoutForeignManagedHookGroups(
  settings: ClaudeSettings,
  wrap: WrapState,
): ClaudeSettings {
  const hooks = filterClaudeHookGroups(
    settings.hooks ?? {},
    (group) =>
      isMateGuardHookGroup(group) ||
      wrap.carriesClaudeHookGroup(group) ||
      !isManagedHookGroup(group),
  );
  const next = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

/**
 * Reconciles `permissions.additionalDirectories` so the active companion is
 * reachable and no other registered companion lingers, and strips hook groups
 * earlier releases wrote here. Everything else in the document is preserved
 * byte-for-byte: an unchanged document is not rewritten, so `current` really
 * means untouched.
 */
export async function syncWorkingRepoClaudeAdditionalDirectories(
  repoPath: string,
  companionPath: string,
  globalConfigStore: GlobalConfigStore = new GlobalConfigStore(),
): Promise<"written" | "current" | ProjectionWriteReport> {
  const destination = settingsPath(repoPath);
  if ("warning" in destination) return { state: "skipped", warnings: [destination.warning] };
  const target = destination.path;
  const raw = await readRaw(target);
  const existing = withoutForeignManagedHookGroups(
    parseSettings(raw),
    await readWrapState(repoPath),
  );
  const permissions = { ...existing.permissions };
  const existingAdditionalDirectories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories
    : [];
  const registeredCompanionPaths = new Set(
    (await globalConfigStore.list()).map((registeredCompanionPath) =>
      path.resolve(registeredCompanionPath),
    ),
  );
  const resolvedCompanionPath = path.resolve(companionPath);
  const additionalDirectories = Array.from(
    new Set(
      existingAdditionalDirectories
        .map((directory) => path.resolve(directory))
        .filter(
          (directory) =>
            !registeredCompanionPaths.has(directory) || directory === resolvedCompanionPath,
        )
        .concat(resolvedCompanionPath),
    ),
  );

  const next = serializeClaudeSettings({
    ...existing,
    permissions: {
      ...permissions,
      additionalDirectories,
    },
  });
  if (next === raw) return "current";

  await fs.mkdir(path.dirname(target), { recursive: true });
  /** A rename replaces a symlinked leaf instead of writing through it. */
  await writeAtomic(target, next);
  return "written";
}

/**
 * Strips Mate's entries and leaves the document Mate found. A document carrying
 * none of them is not rewritten at all, so its formatting survives; a document
 * left empty is deleted along with any directory Mate created to hold it.
 */
export async function removeWorkingRepoClaudeSettings(
  repoPath: string,
  registeredCompanionPaths: string[] = [],
): Promise<"removed" | "absent" | ProjectionRemovalReport> {
  const destination = settingsPath(repoPath);
  if ("warning" in destination) return removalWithWarnings("absent", [destination.warning]);
  const target = destination.path;
  const raw = await readRaw(target);
  if (raw === null) return "absent";

  const existing = parseSettings(raw);
  const settings = removeManagedHookGroups(existing);
  const permissions = { ...settings.permissions };
  const managedPaths = new Set(
    registeredCompanionPaths.map((candidate) => path.resolve(candidate)),
  );
  const currentDirectories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories
    : [];
  const additionalDirectories = currentDirectories.filter(
    (candidate) => !managedPaths.has(path.resolve(candidate)),
  );
  if (additionalDirectories.length > 0) {
    permissions.additionalDirectories = additionalDirectories;
  } else {
    delete permissions.additionalDirectories;
  }
  if (Object.keys(permissions).length > 0) {
    settings.permissions = permissions;
  } else {
    delete settings.permissions;
  }

  if (JSON.stringify(settings) === JSON.stringify(existing)) return "absent";
  if (Object.keys(settings).length === 0) {
    await fs.unlink(target);
    await pruneEmptyAncestors(path.dirname(target), destination.root);
    return "removed";
  }
  await writeAtomic(target, serializeClaudeSettings(settings));
  return "removed";
}

/** Present when Mate's own key is in the document, not merely when it exists. */
export async function workingRepoClaudeSettingsPresent(repoPath: string): Promise<boolean> {
  const destination = settingsPath(repoPath);
  if ("warning" in destination) return false;
  const settings = parseSettings(await readRaw(destination.path));
  return Array.isArray(settings.permissions?.additionalDirectories);
}

/**
 * The TokenSave installer appends a block to a Working Repository's `CLAUDE.md`.
 * Mate never writes it, which is why the entry is removal-only: a launch strips
 * it the same way `unproject` does.
 */
export async function stripTokensaveClaudeMdAppend(
  repoPath: string,
): Promise<"removed" | "absent"> {
  const claudeMd = await readClaudeMd(repoPath);
  if (claudeMd === null) return "absent";

  const stripped = cutFromMarker(claudeMd.content, TOKENSAVE_CLAUDE_MD_MARKER);
  if (stripped === claudeMd.content) return "absent";
  if (stripped.length > 0) {
    await writeAtomic(claudeMd.path, stripped);
  } else {
    await fs.unlink(claudeMd.path);
  }
  return "removed";
}

export async function legacyTokensaveClaudeMdPresent(repoPath: string): Promise<boolean> {
  const claudeMd = await readClaudeMd(repoPath);
  return claudeMd !== null && claudeMd.content.includes(TOKENSAVE_CLAUDE_MD_MARKER);
}
