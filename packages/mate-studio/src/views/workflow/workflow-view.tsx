import type { StudioChange, StudioCompanionPayload } from "@uniqbit/mate-core/studio";

import { changeStep } from "../overview/change-group";
import { Warnings } from "../warnings";
import { DeliveryPathView, type StageChanges, type StageCounts } from "./delivery-path";

interface WorkflowProps {
  payload: Pick<StudioCompanionPayload, "skills" | "topology" | "warnings">;
  /** The companion's active changes, placed on the graph at the stage the Overview names. */
  changes?: StudioChange[];
}

/** Graph node per change stage, in path order; matches the stage the Overview panel names. */
const STAGE_NODES: { node: string; label: string }[] = [
  { node: "propose", label: "Propose change" },
  { node: "reviews", label: "Human review" },
  { node: "apply", label: "Apply change" },
  { node: "archive", label: "Archive change" },
];

function stagesOf(changes: StudioChange[]): {
  counts: StageCounts;
  byStage: StageChanges[];
} {
  const byStage: StageChanges[] = STAGE_NODES.map((stage) => ({
    ...stage,
    changes: changes.flatMap((change) =>
      changeStep(change).stage === stage.label ? [change.name] : [],
    ),
  }));
  const counts: StageCounts = {};
  for (const stage of byStage)
    if (stage.changes.length > 0) counts[stage.node] = stage.changes.length;
  return { counts, byStage };
}

const NO_CHANGES: StudioChange[] = [];

export function Workflow({ payload, changes = NO_CHANGES }: WorkflowProps) {
  const { counts, byStage } = stagesOf(changes);
  return (
    <>
      <Warnings warnings={payload.warnings} />
      <div className="workflow-view">
        <DeliveryPathView payload={payload} counts={counts} changesByStage={byStage} />
      </div>
    </>
  );
}
