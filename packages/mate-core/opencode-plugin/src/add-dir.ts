import path from "node:path";

import type { Context } from "@opencode/plugin/promise/plugin";

import { loadSkillInfos } from "../../src/runtime/opencode-audience-layer";

function companionSkillPaths(companionPath: string): string[] {
  return [
    path.join(companionPath, ".agents", "skills"),
    path.join(companionPath, ".opencode", "skills"),
  ];
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Grants the session access to the companion and registers its skills. The
 * permission hook only widens access for companion resources; every other
 * evaluation keeps OpenCode's own verdict.
 */
export async function registerCompanionAccess(
  api: Context,
  companionPath: string,
  extraRoots: readonly string[] = [],
): Promise<void> {
  const permissionRoot = path.resolve(companionPath);
  /** An audience layer's files are as readable as the companion's, for this launch only. */
  const allowedRoots = [permissionRoot, ...extraRoots.map((root) => path.resolve(root))];

  await api.permission.hook("evaluate", (event) => {
    if (event.resources.some((resource) => allowedRoots.some((root) => isWithin(root, resource)))) {
      event.effect = "allow";
      delete event.message;
    }
  });

  const skills = await loadSkillInfos(companionSkillPaths(permissionRoot));
  if (skills.length === 0) return;

  await api.skill.transform((editor) => {
    for (const skill of skills) {
      if (editor.get(skill.id)) {
        editor.update(skill.id, (current) => Object.assign(current, skill));
      } else {
        editor.add(skill as never);
      }
    }
  });
}
