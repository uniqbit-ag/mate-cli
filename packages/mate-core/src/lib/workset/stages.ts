import path from "node:path";

import { archiveAnchors, archiveDirOf } from "../change-layout";
import { isPublishable, readDeliveryState } from "../delivery/record";
import {
  readWorksets,
  resolveLinkedChanges,
  type WorksetProblem,
  type WorksetRecord,
} from "./record";
import { type ChangeFacts, type DerivedWorksetStage, deriveWorksetStage } from "./stage";

/** What an active change's OpenSpec status says, as far as its stage needs. */
export interface ActiveChangeState {
  name: string;
  artifacts: { id: string; status?: string }[];
  completedTasks?: number;
}

/**
 * What lib cannot read itself: OpenSpec's active changes and the committed (published)
 * archives. Called only when the companion has a Workset.
 */
export interface WorksetStageSources {
  activeChanges: () => Promise<ActiveChangeState[]>;
  publishedAnchors: () => Promise<Iterable<string>>;
  readWorksets?: typeof readWorksets;
  archiveAnchors?: typeof archiveAnchors;
  /** Whether an archive's Publication Merge Gate is open: merged, not applicable, or legacy. */
  archiveMergeSettled?: (companionPath: string, anchor: string) => Promise<boolean>;
}

export interface WorksetWithStage {
  record: WorksetRecord;
  derived: DerivedWorksetStage;
}

async function archiveMergeSettled(companionPath: string, anchor: string): Promise<boolean> {
  const state = await readDeliveryState(path.join(archiveDirOf(companionPath), anchor));
  return isPublishable(state.status);
}

/**
 * Every Workset of a companion with its derived stage. Delivery Records are read only for
 * archives a Workset links, so a companion without Worksets pays nothing.
 */
export async function readWorksetStages(
  companionPath: string,
  sources: WorksetStageSources,
): Promise<{ worksets: WorksetWithStage[]; problems: WorksetProblem[] }> {
  const listing = await (sources.readWorksets ?? readWorksets)(companionPath);
  if (listing.worksets.length === 0) return { worksets: [], problems: listing.problems };

  const [changes, published, anchors] = await Promise.all([
    sources.activeChanges(),
    sources.publishedAnchors().then((publishedAnchors) => new Set(publishedAnchors)),
    (sources.archiveAnchors ?? archiveAnchors)(companionPath),
  ]);
  const linked = resolveLinkedChanges(
    listing.worksets,
    changes.map((change) => change.name),
    anchors,
  );
  const mergeSettled = sources.archiveMergeSettled ?? archiveMergeSettled;
  const activeByName = new Map(changes.map((change) => [change.name, change]));

  const unique = new Map([...linked.values()].flat().map((change) => [change.name, change]));
  const entries = await Promise.all(
    [...unique.values()].map(async (change): Promise<[string, ChangeFacts] | null> => {
      if (change.kind === "active") {
        const active = activeByName.get(change.name)!;
        return [
          change.name,
          {
            name: change.name,
            archived: false,
            artifactsComplete:
              active.artifacts.length > 0 &&
              active.artifacts.every((artifact) => artifact.status === "done"),
            reviewArtifacts: active.artifacts.map((artifact) => artifact.id),
            checkedTasks: active.completedTasks ?? 0,
            mergeSettled: false,
            published: false,
          },
        ];
      }
      if (change.kind === "archived") {
        return [
          change.name,
          {
            name: change.name,
            archived: true,
            artifactsComplete: true,
            reviewArtifacts: [],
            checkedTasks: 0,
            mergeSettled: await mergeSettled(companionPath, change.anchor),
            published: published.has(change.anchor),
          },
        ];
      }
      return null;
    }),
  );
  const facts = new Map(entries.filter((entry) => entry !== null));

  return {
    worksets: listing.worksets.map((record) => ({
      record,
      derived: deriveWorksetStage(record, linked.get(record.id) ?? [], (name) => facts.get(name)),
    })),
    problems: listing.problems,
  };
}
