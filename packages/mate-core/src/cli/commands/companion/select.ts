import path from "node:path";

import { FRAMEWORK_NAME } from "../../../framework";
import {
  findRepoLocalRegistryFile,
  selectRepoLocalCompanion,
} from "../../../lib/orchestrator/repo-local-registry";

/**
 * @command mate companion select <id>
 * @description Pins the per-user companion choice for a working repository
 * linked to multiple companions. `<id>` matches a companion path, its
 * basename, or the pointer's repository id. The pin lives in the gitignored
 * repo-local `.mate` configuration; sessions started afterwards activate the
 * pinned companion without asking again.
 */
export async function runCompanionSelectCommand(
  argv: string[],
  cwd = process.cwd(),
): Promise<void> {
  const id = argv[0]?.trim();
  if (!id) {
    console.error(`${FRAMEWORK_NAME}: usage: ${FRAMEWORK_NAME} companion select <id>`);
    process.exitCode = 1;
    return;
  }

  const found = await findRepoLocalRegistryFile(path.resolve(cwd));
  if (!found) {
    console.error(
      `${FRAMEWORK_NAME}: no linked working repository found for ${cwd}. Run \`${FRAMEWORK_NAME} companion link\` first.`,
    );
    process.exitCode = 1;
    return;
  }

  const selected = await selectRepoLocalCompanion(found.repoRoot, id);
  if (!selected) {
    console.error(
      `${FRAMEWORK_NAME}: no linked companion matches "${id}". Run \`${FRAMEWORK_NAME} companion list\` to see candidates.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Pinned companion for this repository: ${path.resolve(selected.path)}`);
  console.log(
    "New sessions use it automatically. Open OpenCode sessions reactivate on their own after the current reply; Claude sessions need a restart.",
  );
}
