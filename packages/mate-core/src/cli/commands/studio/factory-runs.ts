import { parseRemote } from "../../../lib/delivery/forge";
import type { RunState } from "../../../lib/factory/runner/state";
import { readWorksets } from "../../../lib/workset/record";
import { repositorySources } from "../../../lib/workset/repositories";
import type { StudioFactoryRunner } from "./factory-runner";

/** A Workset's run as the board shows it. */
export type FactoryRunView = RunState & {
  pushedBranch?: string;
  /** Where to open a pull request for the pushed branch, when the forge is known. */
  compareUrl?: string;
};

/** A GitHub compare page for the branch; other forges show the branch name only. */
export function compareUrlFor(remoteUrl: string, branch: string): string | undefined {
  const remote = parseRemote(remoteUrl);
  if (remote?.host !== "github.com") return undefined;
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${branch}?expand=1`;
}

export async function factoryRunsView(
  studioRunner: StudioFactoryRunner,
  companionPath: string,
): Promise<Record<string, FactoryRunView>> {
  const [states, { worksets }, sources] = await Promise.all([
    studioRunner.store.all(),
    readWorksets(companionPath),
    repositorySources(companionPath).catch(() => new Map<string, string>()),
  ]);
  const views: Record<string, FactoryRunView> = {};
  await Promise.all(
    worksets.map(async (workset) => {
      const state = states.get(workset.id);
      const memory = await studioRunner.store.readMemory(workset.id);
      if (!state && !memory.pushedBranch) return;
      const remote = sources.get(workset.repositories[0] ?? "");
      views[workset.id] = {
        ...(state ?? { state: "idle", updatedAt: "" }),
        ...(memory.pushedBranch ? { pushedBranch: memory.pushedBranch } : {}),
        ...(memory.pushedBranch && remote
          ? { compareUrl: compareUrlFor(remote, memory.pushedBranch) }
          : {}),
      };
    }),
  );
  return views;
}
