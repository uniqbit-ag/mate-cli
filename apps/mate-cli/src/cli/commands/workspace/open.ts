import { CompanionStore } from "../../../lib/orchestrator/companion-store";
import { resolveForLaunch } from "../../../lib/orchestrator/framework-context";
import { injectEditorFolder, getPreferredEditorCli } from "../../../lib/orchestrator/editor";
import { ensureUnambiguousCompanion } from "../launch/shared";

export const workspaceOpenCommandDeps = {
  ensureUnambiguousCompanion: () => ensureUnambiguousCompanion(),
  resolveLaunchContext: () => resolveForLaunch(process.cwd()),
  createStore: (
    configStore: ConstructorParameters<typeof CompanionStore>[0],
    workingRepoStore: ConstructorParameters<typeof CompanionStore>[1],
  ) => new CompanionStore(configStore, workingRepoStore),
  getPreferredEditorCli: () => getPreferredEditorCli(),
  injectEditorFolder,
};

/**
 * @command mate companion open
 * @description Adds the active working repository and companion directory to
 * the current editor window (resolved via {@link getPreferredEditorCli}) using
 * `--add`, instead of opening a new window. Replaces any previously-injected
 * companion so the window only ever has the currently linked one attached.
 * @remarks Throws if the active repository (from `MATE_REPO_ID`) isn't found
 * in the registry; sets a non-zero exit code if the editor CLI is unavailable,
 * or if the working repo is linked from multiple companions and the ambiguity
 * can't be resolved (see {@link ensureUnambiguousCompanion}).
 */
export async function runWorkspaceOpenCommand(): Promise<void> {
  const unambiguous = await workspaceOpenCommandDeps.ensureUnambiguousCompanion();
  if (!unambiguous) {
    process.exitCode = 1;
    return;
  }

  const {
    companionPath,
    repositoryId,
    repository: localRepository,
    configStore,
    workingRepoStore,
  } = await workspaceOpenCommandDeps.resolveLaunchContext();
  const repository =
    localRepository ??
    (await workspaceOpenCommandDeps
      .createStore(configStore, workingRepoStore)
      .getRepository(repositoryId));

  if (!repository) {
    throw new Error(`Linked repository not found: ${repositoryId}`);
  }

  const injected = await workspaceOpenCommandDeps.injectEditorFolder(
    companionPath,
    repository.path,
    workspaceOpenCommandDeps.getPreferredEditorCli(),
  );

  if (!injected) {
    process.exitCode = 1;
  }
}
