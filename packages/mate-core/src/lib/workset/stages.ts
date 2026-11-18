import path from "node:path";

import { archiveAnchors, archiveDirOf, changesDirOf } from "../change-layout";
import { type DeliveryStatus, isPublishable, readDeliveryState } from "../delivery/record";
import { discoverSubmitted } from "../delivery/staging/pending";
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
  /** An active change's submission state and settlement, from its local Delivery Record. */
  activeDelivery?: (companionPath: string, change: string) => Promise<ActiveDelivery>;
  /**
   * Submitted changes on the pending branch as last fetched, where merges are recorded. Asked
   * only when a linked change is submitted; a failure falls back to the local records.
   */
  submittedChanges?: (companionPath: string) => Promise<SubmittedDelivery[]>;
}

export interface ActiveDelivery {
  submitted: boolean;
  status: DeliveryStatus;
}

export interface SubmittedDelivery {
  name: string;
  delivery: { status: DeliveryStatus };
}

export interface WorksetWithStage {
  record: WorksetRecord;
  derived: DerivedWorksetStage;
}

async function archiveMergeSettled(companionPath: string, anchor: string): Promise<boolean> {
  const state = await readDeliveryState(path.join(archiveDirOf(companionPath), anchor));
  return isPublishable(state.status);
}

async function activeDelivery(companionPath: string, change: string): Promise<ActiveDelivery> {
  const state = await readDeliveryState(path.join(changesDirOf(companionPath), change));
  return { submitted: state.record?.state === "submitted", status: state.status };
}

/** Local Git only: a stage never fetches the pending branch. */
async function submittedChanges(companionPath: string): Promise<SubmittedDelivery[]> {
  const discovery = await discoverSubmitted(companionPath, { fetch: false });
  return discovery.groups.flatMap((group) => group.changes);
}

/**
 * Every Workset of a companion with its derived stage. Delivery Records are read only for
 * changes a Workset links, so a companion without Worksets pays nothing.
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
  const deliveryOf = sources.activeDelivery ?? activeDelivery;
  const local = new Map(
    await Promise.all(
      [...unique.values()]
        .filter((change) => change.kind === "active")
        .map(
          async (change) =>
            [
              change.name,
              await deliveryOf(companionPath, change.name).catch((): ActiveDelivery => ({
                submitted: false,
                status: "unlinked",
              })),
            ] as const,
        ),
    ),
  );
  // The merge is recorded on the pending branch's copy, so the local record can lag behind it.
  const pending = new Map<string, DeliveryStatus>(
    [...local.values()].some((delivery) => delivery.submitted)
      ? (
          await (sources.submittedChanges ?? submittedChanges)(companionPath).catch(
            (): SubmittedDelivery[] => [],
          )
        ).map((change) => [change.name, change.delivery.status])
      : [],
  );
  const entries = await Promise.all(
    [...unique.values()].map(async (change): Promise<[string, ChangeFacts] | null> => {
      if (change.kind === "active") {
        const active = activeByName.get(change.name)!;
        const delivery = local.get(change.name)!;
        return [
          change.name,
          {
            name: change.name,
            archived: false,
            submitted: delivery.submitted,
            artifactsComplete:
              active.artifacts.length > 0 &&
              active.artifacts.every((artifact) => artifact.status === "done"),
            reviewArtifacts: active.artifacts.map((artifact) => artifact.id),
            checkedTasks: active.completedTasks ?? 0,
            mergeSettled:
              delivery.submitted && isPublishable(pending.get(change.name) ?? delivery.status),
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
            submitted: false,
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
