// oxlint-disable no-await-in-loop
import fs from "node:fs/promises";
import path from "node:path";

import type { SkillTreeContribution } from "../plugin";
import { mergeDir, pruneEmptyAncestors } from "../utils";

/**
 * Agent Runtimes that read the vendor-neutral companion `.agents/skills` root.
 * Claude is never a member: it reads only `.claude/skills`.
 */
export const SHARED_SKILL_ROOT_RUNTIMES = ["opencode"] as const;

export function isSharedSkillRootActive(activeProviders: readonly string[]): boolean {
  return SHARED_SKILL_ROOT_RUNTIMES.some((runtime) => activeProviders.includes(runtime));
}

export function getSharedSkillsDir(companionPath: string): string {
  return path.join(companionPath, ".agents", "skills");
}

function getLegacyOpenCodeSkillsDir(companionPath: string): string {
  return path.join(companionPath, ".opencode", "skills");
}

/** Mate owns skill-root entries only by name; the directory itself is never listed or wiped. */
async function removeSkillNames(
  skillsDir: string,
  names: readonly string[],
  companionPath: string,
): Promise<void> {
  for (const name of names) {
    await fs.rm(path.join(skillsDir, name), { recursive: true, force: true });
  }
  await pruneEmptyAncestors(skillsDir, companionPath);
}

export async function removeSharedSkills(
  companionPath: string,
  names: readonly string[],
): Promise<void> {
  await removeSkillNames(getSharedSkillsDir(companionPath), names, companionPath);
}

export async function removeLegacyOpenCodeSkills(
  companionPath: string,
  names: readonly string[],
): Promise<void> {
  await removeSkillNames(getLegacyOpenCodeSkillsDir(companionPath), names, companionPath);
}

export interface SharedSkillTreeState {
  /** Capability enabled and the reconciling runtime active. */
  enabled: boolean;
  /** Capability enabled regardless of runtime; separates disable from runtime deselect. */
  capabilityEnabled: boolean;
  activeProviders: readonly string[];
}

/**
 * Reconcile one declared skill tree into the shared root. A deselected runtime
 * keeps the tree while another reading runtime is still active.
 */
export async function reconcileSharedSkillTree(
  companionPath: string,
  skillTree: SkillTreeContribution,
  state: SharedSkillTreeState,
): Promise<void> {
  await removeLegacyOpenCodeSkills(companionPath, [skillTree.name]);
  if (state.enabled) {
    await mergeDir(
      skillTree.sourceDir,
      path.join(getSharedSkillsDir(companionPath), skillTree.name),
    );
    return;
  }
  if (state.capabilityEnabled && isSharedSkillRootActive(state.activeProviders)) return;
  await removeSharedSkills(companionPath, [skillTree.name]);
}
