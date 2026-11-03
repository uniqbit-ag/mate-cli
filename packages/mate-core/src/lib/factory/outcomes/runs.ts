import { parseRemote } from "../../delivery/forge";
import { type ControlState, type RunState, type Situation } from "../runner/state";
import type { Run } from "../runner/run";
import { readWorksets } from "../../workset/record";
import { repositorySources } from "../../workset/repositories";
import { NO_CREDENTIAL } from "../credential-store";

/** A Workset's run as the board shows it. */
export type FactoryRunView = RunState & {
  pushedBranch?: string;
  /** Where to open a pull request for the pushed branch, when the forge is known. */
  compareUrl?: string;
  /** Stored review report id per proposed change. */
  reviewReports?: Record<string, string>;
  /** What the agent reported for a person, newest first. */
  situations?: Situation[];
  /** Set while a person has, or asked for, the conversation. */
  control?: ControlState;
  /** The factory has a Claude session a person can take over. */
  conversation?: boolean;
  /** The run has a stored log to replay. */
  hasLog?: boolean;
  /** It failed for want of an agent credential; the board links to the Agents panel. */
  needsCredential?: boolean;
};

/** A GitHub compare page for the branch; other forges show the branch name only. */
export function compareUrlFor(remoteUrl: string, branch: string): string | undefined {
  const remote = parseRemote(remoteUrl);
  if (remote?.host !== "github.com") return undefined;
  return `https://github.com/${remote.owner}/${remote.repo}/compare/${branch}?expand=1`;
}

/**
 * Every Workset's run as the board shows it. Review report ids the store no longer keeps
 * are dropped, so the board offers Regenerate.
 */
export async function runViews(
  runs: Run,
  companionPath: string,
  keptReports: () => Promise<string[]>,
): Promise<Record<string, FactoryRunView>> {
  const [{ worksets }, sources, kept] = await Promise.all([
    readWorksets(companionPath),
    repositorySources(companionPath).catch(() => new Map<string, string>()),
    keptReports().then(
      (ids) => new Set(ids),
      () => new Set<string>(),
    ),
  ]);
  const facts = await runs.allFacts(worksets.map((workset) => workset.id));
  const views: Record<string, FactoryRunView> = {};
  for (const workset of worksets) {
    const { execution, recorded, memory, control, hasLog, conversation } = facts.get(workset.id)!;
    const state = recorded ? execution : undefined;
    if (!state && !memory.pushedBranch && !memory.reviewReports && !memory.situations) continue;
    const remote = sources.get(workset.repositories[0] ?? "");
    views[workset.id] = {
      ...(state ?? { state: "idle", updatedAt: "" }),
      ...(memory.pushedBranch ? { pushedBranch: memory.pushedBranch } : {}),
      ...(memory.reviewReports
        ? {
            reviewReports: Object.fromEntries(
              Object.entries(memory.reviewReports).filter(([, reportId]) => kept.has(reportId)),
            ),
          }
        : {}),
      ...(memory.situations?.length ? { situations: memory.situations } : {}),
      ...(control.mode === "automatic" ? {} : { control }),
      ...(conversation ? { conversation: true } : {}),
      ...(hasLog ? { hasLog: true } : {}),
      ...(state?.state === "failed" && state.reason.includes(NO_CREDENTIAL)
        ? { needsCredential: true }
        : {}),
      ...(memory.pushedBranch && remote
        ? { compareUrl: compareUrlFor(remote, memory.pushedBranch) }
        : {}),
    };
  }
  return views;
}
