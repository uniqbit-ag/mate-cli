interface SelectPanels {
  root: string;
  select: string;
  panel: string;
  /** Skills panels also hide from assistive technology when inactive. */
  hidePanels: boolean;
}

/** Shows the panel named by a select's value; the server marks the first one active. */
function wireSelectPanels({ root, select, panel, hidePanels }: SelectPanels): void {
  document.querySelectorAll(`[${root}]`).forEach((scope) => {
    const control = scope.querySelector(`[${select}]`) as HTMLSelectElement | null;
    if (!control) return;
    const panels = scope.querySelectorAll(`[${panel}]`);
    function show(): void {
      panels.forEach((node) => {
        const active = node.getAttribute(panel) === control!.value;
        node.setAttribute("data-active", active ? "true" : "false");
        if (hidePanels) node.setAttribute("aria-hidden", active ? "false" : "true");
      });
    }
    control.addEventListener("change", show);
    show();
  });
}

export function wireWorkflowSchemaSelect(): void {
  wireSelectPanels({
    root: "data-workflow-schema-root",
    select: "data-workflow-schema-select",
    panel: "data-workflow-schema-panel",
    hidePanels: false,
  });
}

export function wireSkillsSelect(): void {
  wireSelectPanels({
    root: "data-skills-root",
    select: "data-skills-select",
    panel: "data-skill-panel",
    hidePanels: true,
  });
}

function markSelectedStage(): void {
  document.querySelectorAll("a[data-map-stage]").forEach((link) => {
    if (link.getAttribute("href") === location.hash) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  });
}

/** Marks the graph node whose card the address targets; CSS shows the card itself. */
export function wireWorkflowStageSelection(): void {
  if (!document.querySelector("a[data-map-stage]")) return;
  window.addEventListener("hashchange", markSelectedStage);
  markSelectedStage();
}
