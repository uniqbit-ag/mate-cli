import type { StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import { useEffect } from "react";

import { Warnings } from "../warnings";
import { DeliveryPathView } from "./delivery-path";

interface WorkflowProps {
  payload: Pick<StudioCompanionPayload, "skills" | "topology" | "warnings">;
}

/** Marks the graph node whose card the address targets; CSS shows the card itself. */
function useSelectedStage(): void {
  useEffect(() => {
    const mark = () => {
      for (const link of document.querySelectorAll("a[data-map-stage]")) {
        if (link.getAttribute("href") === location.hash) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
    };
    mark();
    window.addEventListener("hashchange", mark);
    return () => window.removeEventListener("hashchange", mark);
  }, []);
}

export function Workflow({ payload }: WorkflowProps) {
  useSelectedStage();
  return (
    <>
      <div className="workflow-view">
        <DeliveryPathView payload={payload} />
      </div>
      <Warnings warnings={payload.warnings} />
    </>
  );
}
