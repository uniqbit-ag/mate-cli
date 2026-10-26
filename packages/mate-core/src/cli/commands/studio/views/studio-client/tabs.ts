interface TabAttributes {
  root: string;
  tab: string;
  panel: string;
  /** Skills panels also hide from assistive technology when inactive. */
  hidePanels: boolean;
}

function wireTabs({ root, tab, panel, hidePanels }: TabAttributes): void {
  document.querySelectorAll(`[${root}]`).forEach((scope) => {
    const tabs = scope.querySelectorAll(`[${tab}]`);
    const panels = scope.querySelectorAll(`[${panel}]`);

    function select(profile: string | null): void {
      tabs.forEach((node) => {
        node.setAttribute("aria-selected", node.getAttribute(tab) === profile ? "true" : "false");
      });
      panels.forEach((node) => {
        const active = node.getAttribute(panel) === profile;
        node.setAttribute("data-active", active ? "true" : "false");
        if (hidePanels) node.setAttribute("aria-hidden", active ? "false" : "true");
      });
    }

    tabs.forEach((node) => {
      node.addEventListener("click", () => {
        select(node.getAttribute(tab));
      });
    });

    const selected = scope.querySelector('[aria-selected="true"]');
    if (selected) select(selected.getAttribute(tab));
  });
}

export function wireWorkflowSchemaTabs(): void {
  wireTabs({
    root: "data-workflow-schema-root",
    tab: "data-workflow-schema-profile",
    panel: "data-workflow-schema-panel",
    hidePanels: false,
  });
}

export function wireSkillTabs(): void {
  wireTabs({
    root: "data-skills-root",
    tab: "data-skill-profile",
    panel: "data-skill-panel",
    hidePanels: true,
  });
}
