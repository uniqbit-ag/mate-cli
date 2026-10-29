/** @jsxImportSource hono/jsx */

import { describe, expect, it } from "bun:test";

import type { StudioCompanionPayload } from "../../payload";
import { Workflow } from "./index";
import { buildPath, workflowPlan, type WorkflowMapNode, type WorkflowPath } from "./steps";

const ALL_SKILLS = [
  "mate-clarify-intent",
  "mate-interview-me",
  "mate-grill-me",
  "mate-grill-with-docs",
  "mate-explore-change",
  "mate-propose-change",
  "mate-apply-change",
  "mate-show-me",
  "mate-simplify-code",
  "mate-archive-change",
  "mate-publish-artifact",
];

function payload(overrides: Partial<StudioCompanionPayload> = {}): StudioCompanionPayload {
  return {
    companionPath: "/home/dev/.mate/companions/acme-companion",
    changes: [],
    specs: [],
    skills: ALL_SKILLS,
    topology: null,
    warnings: [],
    ...overrides,
  };
}

function render(data: StudioCompanionPayload = payload()): string {
  return String(<Workflow payload={data} />);
}

const labels = (path: WorkflowPath): string[] => path.steps.map((step) => step.label);

/** Consecutive steps of one phase, in stage order. */
const phaseIds = (path: WorkflowPath) => {
  const phases: [string, string[]][] = [];
  for (const step of path.steps) {
    const last = phases.at(-1);
    if (last?.[0] === step.phase) last[1].push(step.id);
    else phases.push([step.phase, [step.id]]);
  }
  return phases;
};

const mapShape = (path: WorkflowPath) =>
  path.map.map((node: WorkflowMapNode) =>
    node.kind === "stage" ? node.step.id : { [node.group]: node.steps.map((step) => step.id) },
  );

const ACME_TOPOLOGY = {
  schemaName: "acme-v1",
  workflowCapabilityId: "openspec",
  source: "project" as const,
  artifacts: [
    { id: "brief", description: "States the outcome.", requires: [] },
    { id: "tasks", requires: ["brief"] },
  ],
  edges: [],
  apply: { requires: ["tasks"] },
};

describe("workflowPlan", () => {
  it("presents the full and minimal paths in Delivery Path order", () => {
    const plan = workflowPlan({ skills: ALL_SKILLS });
    expect(plan.paths.map((path) => path.schema)).toEqual(["mate-v1", "mate-minimal"]);
    expect(labels(plan.paths[0])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review proposal",
      "Review specs",
      "Review design",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Archive change",
      "Publish companion artifacts",
    ]);
    expect(labels(plan.paths[1])).toEqual([
      "Clarify intent",
      "Explore change",
      "Propose change",
      "Review specs",
      "Review tasks",
      "Apply change",
      "Inspect outcome",
      "Refine code",
      "Archive change",
      "Publish companion artifacts",
    ]);
  });

  it("offers clarify-intent by default and the two explicit modes, never grill-with-docs", () => {
    const clarify = workflowPlan({ skills: ALL_SKILLS }).paths[0].steps[0];
    expect(clarify.optional).toBe(true);
    expect(clarify.alternatives?.map((option) => option.name)).toEqual([
      "mate-clarify-intent",
      "mate-interview-me",
      "mate-grill-me",
    ]);
    expect(JSON.stringify(clarify)).not.toContain("mate-grill-with-docs");
  });

  it("marks review stages as human stages with no skill and no prompt", () => {
    for (const step of workflowPlan({ skills: ALL_SKILLS }).paths[0].steps) {
      if (step.kind !== "human") continue;
      expect(step.skill).toBeNull();
      expect(step.prompt).toBeNull();
      expect(step.badges).toEqual(["human-review"]);
    }
  });

  it("marks the stages that run on OpenSpec", () => {
    const openspec = workflowPlan({ skills: ALL_SKILLS })
      .paths[0].steps.filter((step) => step.badges.includes("openspec"))
      .map((step) => step.id);
    expect(openspec).toEqual(["explore", "propose", "apply", "archive"]);
  });

  it("names each skill stage's Mate skill in its prompt", () => {
    const prompts = workflowPlan({ skills: ALL_SKILLS })
      .paths[0].steps.filter((step) => step.kind === "skill" && !step.alternatives)
      .map((step) => step.prompt);
    expect(prompts).toEqual([
      "/mate-explore-change for <change-name>",
      "/mate-propose-change for <change-name>",
      "/mate-apply-change for <change-name>",
      "/mate-show-me for <change-name>",
      "/mate-simplify-code for <change-name>",
      "/mate-archive-change for <change-name>",
      "/mate-publish-artifact for <change-name>",
    ]);
  });

  it("reports a missing stage skill instead of hiding the stage", () => {
    const steps = workflowPlan({
      skills: ALL_SKILLS.filter((skill) => skill !== "mate-archive-change"),
    }).paths[0].steps;
    const archive = steps.find((step) => step.id === "archive");
    expect(archive?.missingSkill).toBe("mate-archive-change");
  });

  it("reports a missing optional peer skill instead of hiding the stage", () => {
    const steps = workflowPlan({
      skills: ALL_SKILLS.filter((skill) => skill !== "mate-show-me"),
    }).paths[0].steps;
    expect(steps.find((step) => step.id === "inspect-outcome")?.missingSkill).toBe("mate-show-me");
    expect(steps.find((step) => step.id === "refine-code")?.sessionBreakBefore).toBeUndefined();
  });

  it("reports the missing default Clarify skill while its explicit modes remain", () => {
    const clarify = workflowPlan({
      skills: ALL_SKILLS.filter((skill) => skill !== "mate-clarify-intent"),
    }).paths[0].steps[0];
    expect(clarify.missingSkill).toBe("mate-clarify-intent");
    expect(clarify.alternatives?.map((mode) => mode.name)).toEqual([
      "mate-interview-me",
      "mate-grill-me",
    ]);
  });

  it("takes review stages and their purpose from the served topology", () => {
    const plan = workflowPlan({
      skills: ALL_SKILLS,
      topology: ACME_TOPOLOGY,
    });
    expect(plan.paths).toHaveLength(1);
    expect(plan.paths[0].tagline).toBe("custom schema");
    const brief = plan.paths[0].steps.find((step) => step.id === "review-brief");
    expect(brief?.what).toBe("States the outcome.");
  });
});

describe("workflowPlan phases and map", () => {
  it("groups the full path into Plan, Review, Build, and Ship", () => {
    const path = workflowPlan({ skills: ALL_SKILLS }).paths[0];
    expect(phaseIds(path)).toEqual([
      ["plan", ["clarify-intent", "explore", "propose"]],
      ["review", ["review-proposal", "review-specs", "review-design", "review-tasks"]],
      ["build", ["apply", "inspect-outcome", "refine-code"]],
      ["ship", ["archive", "publish"]],
    ]);
    expect(mapShape(path)).toEqual([
      "clarify-intent",
      "explore",
      "propose",
      { human: ["review-proposal", "review-specs", "review-design", "review-tasks"] },
      "apply",
      { optional: ["inspect-outcome", "refine-code"] },
      "archive",
      "publish",
    ]);
  });

  it("holds only the specs and tasks reviews on the minimal path", () => {
    const path = workflowPlan({ skills: ALL_SKILLS }).paths[1];
    expect(phaseIds(path)[1]).toEqual(["review", ["review-specs", "review-tasks"]]);
    expect(mapShape(path)[3]).toEqual({ human: ["review-specs", "review-tasks"] });
  });

  it("derives phases and map groups for a custom schema's reviews", () => {
    const path = workflowPlan({ skills: ALL_SKILLS, topology: ACME_TOPOLOGY }).paths[0];
    expect(phaseIds(path)[1]).toEqual(["review", ["review-brief", "review-tasks"]]);
    expect(mapShape(path)[3]).toEqual({ human: ["review-brief", "review-tasks"] });
  });

  it("drops the Review phase and group when reviews are unknown", () => {
    const path = buildPath("acme-v1", undefined, { skills: ALL_SKILLS });
    expect(path.reviewsKnown).toBe(false);
    expect(phaseIds(path).map(([phase]) => phase)).toEqual(["plan", "build", "ship"]);
    expect(path.steps.find((step) => step.id === "apply")?.sessionBreakBefore).toBe(true);
    expect(path.map.some((node) => node.kind === "group" && node.group === "human")).toBe(false);
  });
});

describe("Workflow view", () => {
  it("renders the stages without a change picker", () => {
    const markup = render();
    expect(markup).toContain('class="workflow-delivery-path"');
    expect(markup).toContain("Archive change");
    expect(markup).toContain("mate-archive-change");
    expect(markup).toContain("Review specs yourself — no skill, no prompt");
    expect(markup).not.toContain('name="change"');
  });

  it("offers the schema paths in one select, without the prompts note", () => {
    const markup = render();
    expect(markup).toContain("OpenSpec schema");
    expect(markup).toContain('<select data-workflow-schema-select="true">');
    expect(markup).toContain(
      '<option value="mate-v1" selected="">mate-v1 – full planning</option>',
    );
    expect(markup).toContain(
      '<option value="mate-minimal">mate-minimal – minimal planning</option>',
    );
    expect(markup).toContain('data-workflow-schema-panel="mate-minimal"');
    expect(markup).not.toContain('role="tablist"');
    expect(markup).not.toContain("name the change after pasting");
  });

  it("opens on a hint to select a node and offers no whole-run copy", () => {
    const markup = render();
    expect(markup).toContain("Select a node in the graph");
    expect(markup).not.toContain("the whole run");
  });

  /** The markup of the mate-v1 panel alone. */
  const fullPanel = (markup: string): string =>
    markup.slice(
      markup.indexOf('data-workflow-schema-panel="mate-v1"'),
      markup.indexOf('data-workflow-schema-panel="mate-minimal"'),
    );

  const attributes = (markup: string, name: string): string[] =>
    [...markup.matchAll(new RegExp(`${name}="([^"]+)"`, "g"))].map((match) => match[1]);

  it("opens each path with a flow map whose boxes link to their cards in stage order", () => {
    const panel = fullPanel(render());
    const map = panel.slice(
      panel.indexOf('aria-label="Delivery Path map"'),
      panel.indexOf("</nav>"),
    );
    const stages = workflowPlan({ skills: ALL_SKILLS }).paths[0].steps.map((step) => step.id);
    expect(attributes(map, "data-map-stage")).toEqual(stages);
    expect(attributes(map, "href")).toEqual(stages.map((id) => `#workflow-mate-v1-${id}`));
    for (const id of stages) expect(panel).toContain(`id="workflow-mate-v1-${id}"`);
  });

  /** The graph's markup within a panel. */
  const graphOf = (panel: string): string =>
    panel.slice(panel.indexOf('aria-label="Delivery Path map"'), panel.indexOf("</nav>"));

  const edgeKeys = (markup: string, kind: "flow" | "bypass"): string[] =>
    [
      ...markup.matchAll(
        new RegExp(`data-edge-kind="${kind}" data-edge-from="([^"]+)" data-edge-to="([^"]+)"`, "g"),
      ),
    ].map((match) => `${match[1]}>${match[2]}`);

  it("lists the reviews inside one group node that names no skill", () => {
    const graph = graphOf(fullPanel(render()));
    const start = graph.indexOf('data-map-group="human"');
    const group = graph.slice(start, graph.indexOf("</ol>", start));
    expect(attributes(group, "data-map-stage")).toEqual([
      "review-proposal",
      "review-specs",
      "review-design",
      "review-tasks",
    ]);
    expect(group.replace(/<[^>]+>/g, " ")).not.toContain("mate-");
    expect(graph.match(/data-map-group=/g)).toHaveLength(1);
    expect(graph).toMatch(/data-map-stage="review-specs" data-stage-kind="human"/);
    expect(graph).toMatch(
      /data-map-stage="refine-code" data-stage-kind="skill" data-optional="true"/,
    );
  });

  it("draws the peer branches, bypasses, session marks, and labelled bands", () => {
    const graph = graphOf(fullPanel(render()));
    expect(edgeKeys(graph, "flow")).toEqual(
      expect.arrayContaining([
        "apply>inspect-outcome",
        "apply>refine-code",
        "inspect-outcome>archive",
        "refine-code>archive",
      ]),
    );
    expect(edgeKeys(graph, "bypass")).toEqual(["start>explore", "apply>archive"]);
    expect(attributes(graph, "data-session-mark")).toEqual(["apply"]);
    expect(attributes(graph, "data-band")).toEqual(["plan", "review", "build", "ship"]);
    expect(graph).toMatch(/data-band="review"[^>]*>Review</);
  });

  it("frames the stages each change repeats inside the workset, leaving Publish outside the cycle", () => {
    const panel = fullPanel(render());
    const graph = graphOf(panel);
    const bands = graph.slice(graph.indexOf("workflow-graph-bands"), graph.indexOf("<svg"));
    expect(bands).toMatch(/class="workflow-graph-cycle" style="top:0%;height:88\.8889%"/);
    expect(bands).toContain(">repeats for each change<");
    expect(bands.match(/workflow-graph-cycle/g)).toHaveLength(1);
    expect(bands).toContain('<div class="workflow-graph-workset"><span>workset</span></div>');
    expect(panel).toContain("A workset is one or more changes published together");
  });

  it("marks OpenSpec nodes with a dot the legend explains, hidden from the accessible name", () => {
    const graph = graphOf(fullPanel(render()));
    const node = (id: string) => {
      const start = graph.indexOf(`data-map-stage="${id}"`);
      return graph.slice(start, graph.indexOf("</a>", start));
    };
    expect(node("propose")).toContain('class="workflow-graph-openspec" aria-hidden="true"');
    expect(node("refine-code")).not.toContain("workflow-graph-openspec");
    expect(node("publish")).not.toContain("workflow-graph-openspec");
    const panel = fullPanel(render());
    const legend = panel.slice(
      panel.indexOf("workflow-graph-legend"),
      panel.indexOf("</ul>", panel.indexOf("workflow-graph-legend")),
    );
    expect(panel).toContain('<ul class="workflow-graph-legend" aria-hidden="true">');
    for (const entry of ["optional", "OpenSpec", "new session", "can be skipped"]) {
      expect(legend).toContain(entry);
    }
  });

  it("keeps the drawing out of the accessibility tree", () => {
    const graph = graphOf(fullPanel(render()));
    const nodes = graph.indexOf('class="workflow-graph-nodes"');
    expect(graph).toContain('<div class="workflow-graph-bands" aria-hidden="true">');
    const layers = [...graph.matchAll(/<svg class="workflow-graph-layer"[^>]*>/g)];
    expect(layers).toHaveLength(1);
    expect(layers[0][0]).toContain('aria-hidden="true"');
    expect(graph.lastIndexOf("</svg>")).toBeLessThan(nodes);
    expect(graph.slice(nodes)).not.toContain("data-band");
  });

  it("connects Propose to Apply with no review group when reviews are unknown", () => {
    const graph = graphOf(render(payload({ topology: { ...ACME_TOPOLOGY, artifacts: [] } })));
    expect(edgeKeys(graph, "flow")).toContain("propose>apply");
    expect(attributes(graph, "data-session-mark")[0]).toBe("apply");
    expect(attributes(graph, "data-band")).toEqual(["plan", "build", "ship"]);
  });

  it("puts every card in one side panel after the graph, opening on the path overview", () => {
    const panel = fullPanel(render());
    const aside = panel.slice(panel.indexOf("<aside"), panel.indexOf("</aside>"));
    expect(panel.indexOf("</nav>")).toBeLessThan(panel.indexOf("<aside"));
    const stages = workflowPlan({ skills: ALL_SKILLS }).paths[0].steps.map((step) => step.id);
    expect(attributes(aside, "data-stage")).toEqual(stages);
    expect(aside.indexOf('id="workflow-mate-v1-overview"')).toBeLessThan(aside.indexOf("<article"));
    expect(attributes(aside, "href").filter((href) => href.endsWith("-overview"))).toHaveLength(
      stages.length,
    );
  });

  it("names each card's phase and marks the stages that start a new session", () => {
    const panel = fullPanel(render());
    const card = (id: string) => {
      const start = panel.indexOf(`id="workflow-mate-v1-${id}"`);
      return panel.slice(start, panel.indexOf("</article>", start));
    };
    expect(card("propose")).toContain(">Plan<");
    expect(card("apply")).toContain("Build");
    expect(card("apply")).toContain("New session / clean chat");
    expect(card("inspect-outcome")).not.toContain("New session");
    expect(card("archive")).not.toContain("New session");
  });

  it("keeps the stage content and copy controls on each card", () => {
    const panel = fullPanel(render());
    const card = panel.slice(
      panel.indexOf('id="workflow-mate-v1-propose"'),
      panel.indexOf("</article>", panel.indexOf('id="workflow-mate-v1-propose"')),
    );
    expect(card).toContain("mate-propose-change");
    expect(card).toContain("/mate-propose-change for &lt;change-name&gt;");
    expect(card).toContain('data-copy="/mate-propose-change for"');
    expect(card).toContain("What");
    expect(card).toContain("Why");
    expect(panel).toContain('data-copy-label="mate-interview-me prompt"');
  });

  it("puts no arrow text in the markup", () => {
    const markup = render();
    for (const arrow of ["→", "↓", "-->", "&rarr;"]) expect(markup).not.toContain(arrow);
    expect(markup).not.toContain("workflow-console-gutter");
  });

  it("shows no Review band, group, or card when the schema has no reviews", () => {
    const markup = render(payload({ topology: { ...ACME_TOPOLOGY, artifacts: [] } }));
    expect(markup).not.toContain('data-map-group="human"');
    expect(markup).not.toContain('data-band="review"');
    expect(markup).not.toContain('data-stage="review-');
  });
});
