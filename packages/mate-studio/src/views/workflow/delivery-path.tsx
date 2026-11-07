import { type StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import { useState, type CSSProperties } from "react";

import { CommandLine, Count, ListCard, PAGE_PAD, Pills } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { PanelHead, PanelSection, SidePanel } from "../../shell/panel";
import {
  bandSpan,
  edgeMidpoint,
  edgePath,
  graphAcross,
  nodeCenter,
  percentOf,
  workflowGraph,
  type WorkflowGraph,
} from "./graph";
import { PHASE_LABELS, type WorkflowPath, workflowPlan, type WorkflowStep } from "./steps";

/** Changes at a graph node: `reviews` for the review group, else a stage id. */
export type StageCounts = Partial<Record<string, number>>;

const NO_COUNTS: StageCounts = {};
const NO_STAGES: StageChanges[] = [];

export interface StageChanges {
  node: string;
  label: string;
  changes: string[];
}

export function DeliveryPathView({
  payload,
  counts = NO_COUNTS,
  changesByStage = NO_STAGES,
}: {
  payload: Pick<StudioCompanionPayload, "skills" | "topology">;
  counts?: StageCounts;
  /** The companion's changes at each node, listed beside the graph. */
  changesByStage?: StageChanges[];
}) {
  const plan = workflowPlan({
    skills: payload.skills && payload.skills.length > 0 ? payload.skills : undefined,
    topology: payload.topology,
  });
  const [schema, setSchema] = useState(plan.paths[0]!.schema);
  const path = plan.paths.find((entry) => entry.schema === schema) ?? plan.paths[0]!;

  return (
    <section
      className="workflow-delivery-path @container grid content-start gap-2"
      aria-label="Delivery Path"
    >
      <div className={cn(PAGE_PAD, "flex flex-wrap items-center gap-3")} data-workflow-schema-root>
        <span className="text-sm text-muted">OpenSpec schema</span>
        {plan.paths.length > 1 ? (
          <Pills
            label="OpenSpec schema"
            value={schema}
            onChange={setSchema}
            options={plan.paths.map((entry) => ({ value: entry.schema, label: entry.label }))}
          />
        ) : (
          <code className="font-mono text-sm">{path.label}</code>
        )}
        <span className="text-sm text-muted">{path.tagline}</span>
      </div>
      <PathBody key={path.schema} path={path} counts={counts} changesByStage={changesByStage} />
    </section>
  );
}

const nodeOf = (step: WorkflowStep): string => (step.kind === "human" ? "reviews" : step.id);

/** The graph on the page; one stage's detail opens in the slide-over panel. */
function PathBody({
  path,
  counts,
  changesByStage,
}: {
  path: WorkflowPath;
  counts: StageCounts;
  changesByStage: StageChanges[];
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const step = path.steps.find((entry) => entry.id === selected) ?? null;
  const placed = changesByStage.filter((group) => group.changes.length > 0);
  return (
    <div
      className={cn(
        PAGE_PAD,
        "workflow-path grid grid-cols-[minmax(380px,520px)_minmax(260px,1fr)] items-start gap-10 pt-10 pb-12 @max-[880px]:grid-cols-1",
      )}
      data-workflow-schema-panel={path.schema}
    >
      <div className="workflow-path-graph grid min-w-0 justify-items-center gap-9 px-8">
        <WorkflowGraphView path={path} selected={selected} onSelect={setSelected} counts={counts} />
        <GraphLegend />
      </div>
      <div className="workflow-detail-overview grid content-start gap-5" id={overviewId(path)}>
        <div className="grid gap-2 text-sm leading-relaxed text-muted">
          <p className="workflow-description m-0 text-text">{path.description}</p>
          {!path.reviewsKnown ? (
            <p className="workflow-description m-0">
              The schema&apos;s artifacts could not be read, so its review stages are unknown.
            </p>
          ) : null}
          <p className="workflow-description m-0">
            A workset is one or more changes published together: after Archive change, start again
            at the top for the next change, and publish once they are archived.
          </p>
          <p className="workflow-detail-hint m-0">
            Choose a stage to see what it does and the prompt that runs it.
          </p>
        </div>
        {placed.length > 0 ? (
          <ListCard title="Where your changes are">
            <ul className="m-0 list-none p-0">
              {placed.map((group) => (
                <li
                  key={group.node}
                  className="grid gap-1 border-t border-rule-soft px-4 py-2 first:border-t-0"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    {group.label}
                    <Count value={group.changes.length} />
                  </span>
                  <span className="truncate font-mono text-xs text-muted">
                    {group.changes.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          </ListCard>
        ) : null}
      </div>
      <SidePanel
        items={path.steps.map((entry) => entry.id)}
        current={step?.id ?? null}
        onSelect={setSelected}
        title={step ? `Stage ${step.label}` : "Stage"}
      >
        {step ? (
          <StageDetail
            step={step}
            changes={changesByStage.find((group) => group.node === nodeOf(step))?.changes ?? []}
          />
        ) : null}
      </SidePanel>
    </div>
  );
}

const overviewId = (path: WorkflowPath): string => `workflow-${path.schema}-overview`;

const COUNT_NAMES: Record<string, (count: number) => string> = {
  reviews: (count) => `${count} ${count === 1 ? "change waits" : "changes wait"} for review`,
};

const countName = (node: string, label: string, count: number): string =>
  COUNT_NAMES[node]?.(count) ?? `${count} ${count === 1 ? "change" : "changes"} at ${label}`;

/** How many of the companion's changes are at a node; named for assistive technology. */
function CountBadge({ count, name }: { count: number | undefined; name: string }) {
  if (!count) return null;
  return (
    <span
      className="workflow-graph-count absolute -top-2.5 -right-2.5 z-1 inline-grid h-5 min-w-5 place-items-center rounded-full border border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-accent-soft px-1.5 font-sans text-2xs font-bold text-text"
      aria-label={name}
      role="img"
    >
      {count}
    </span>
  );
}

/**
 * Stage buttons are the only announced part: their document order is the stage order. Bands,
 * edges, and marks are decorative and hidden from assistive technology. Without `onSelect`
 * nodes are plain labels.
 */
function WorkflowGraphView({
  path,
  label = "Delivery Path map",
  selected = null,
  onSelect,
  counts = NO_COUNTS,
}: {
  path: WorkflowPath;
  label?: string;
  selected?: string | null;
  onSelect?: (stage: string) => void;
  counts?: StageCounts;
}) {
  const graph = workflowGraph(path);
  const plain = !onSelect;
  return (
    <nav
      className="workflow-graph"
      aria-label={label}
      style={
        {
          "--graph-columns": String(graph.columns),
          "--graph-rows": String(graph.rows),
        } as CSSProperties
      }
    >
      <div className="workflow-graph-bands" aria-hidden="true">
        {graph.bands.map((band) => (
          <div
            key={band.phase}
            className="workflow-graph-band"
            data-band={band.phase}
            style={bandSpan(graph, band)}
          >
            {band.label}
          </div>
        ))}
        {graph.cycle ? (
          <div className="workflow-graph-cycle" style={bandSpan(graph, graph.cycle)}>
            <span>repeats for each change</span>
          </div>
        ) : null}
        <div className="workflow-graph-workset">
          <span>workset</span>
        </div>
      </div>
      <GraphLayer graph={graph} />
      <ol className="workflow-graph-nodes">
        {graph.nodes.map((node) =>
          node.kind === "start" ? null : (
            <li
              key={node.id}
              className="workflow-graph-node"
              data-node-kind={node.kind}
              style={
                {
                  "--graph-row": String(node.column + 1),
                  "--graph-lane": String(node.row + 1),
                  "--graph-span": String(node.rowSpan),
                } as CSSProperties
              }
            >
              {node.kind === "stage" ? (
                <span className="relative max-w-full">
                  <NodeLink
                    step={node.step}
                    box
                    plain={plain}
                    current={selected === node.step.id}
                    onSelect={onSelect}
                  />
                  {plain ? null : (
                    <CountBadge
                      count={counts[node.id]}
                      name={countName(node.id, node.step.label, counts[node.id] ?? 0)}
                    />
                  )}
                </span>
              ) : (
                <div
                  className="workflow-graph-box workflow-graph-group relative"
                  data-map-group="human"
                  data-current={
                    node.steps.some((step) => step.id === selected) ? "true" : undefined
                  }
                >
                  <span className="workflow-graph-group-label">Human review</span>
                  <ol>
                    {node.steps.map((step) => (
                      <li key={step.id}>
                        <NodeLink
                          step={step}
                          plain={plain}
                          current={selected === step.id}
                          onSelect={onSelect}
                        />
                      </li>
                    ))}
                  </ol>
                  {plain ? null : (
                    <CountBadge
                      count={counts.reviews}
                      name={countName("reviews", "Human review", counts.reviews ?? 0)}
                    />
                  )}
                </div>
              )}
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

/** Explains the graph's visual marks; the panel states the same facts per stage. */
function GraphLegend() {
  return (
    <ul className="workflow-graph-legend" aria-hidden="true">
      <li>
        <i className="workflow-legend-optional" />
        optional
      </li>
      <li>
        <i className="workflow-graph-openspec" />
        OpenSpec
      </li>
      <li>
        <i className="workflow-legend-session" />
        new session
      </li>
      <li>
        <i className="workflow-legend-skip" />
        can be skipped
      </li>
    </ul>
  );
}

function GraphLayer({ graph }: { graph: WorkflowGraph }) {
  return (
    <svg className="workflow-graph-layer" aria-hidden="true" focusable="false">
      <svg
        viewBox={`0 0 ${graphAcross(graph)} ${graph.columns}`}
        preserveAspectRatio="none"
        overflow="visible"
      >
        {graph.edges.map((edge) => (
          <path
            key={`${edge.kind}-${edge.from}-${edge.to}`}
            className="workflow-graph-edge"
            d={edgePath(graph, edge)}
            data-edge-kind={edge.kind}
            data-edge-from={edge.from}
            data-edge-to={edge.to}
            data-new-session={edge.newSession ? "true" : undefined}
          />
        ))}
      </svg>
      {graph.nodes.map((node) => {
        if (node.kind !== "start") return null;
        const { x, y } = percentOf(graph, nodeCenter(node));
        return <circle key={node.id} className="workflow-graph-start" cx={x} cy={y} r="3.5" />;
      })}
      {graph.edges.map((edge) => {
        if (!edge.newSession) return null;
        const { x, y } = percentOf(graph, edgeMidpoint(graph, edge));
        return (
          <circle
            key={`${edge.from}-${edge.to}`}
            className="workflow-graph-session"
            data-session-mark={edge.to}
            cx={x}
            cy={y}
            r="3.5"
          />
        );
      })}
    </svg>
  );
}

/**
 * `box` marks a standalone node; stages inside the review group share its box. `plain` renders
 * a label, for a map that opens nothing.
 */
function NodeLink({
  step,
  box,
  plain,
  current,
  onSelect,
}: {
  step: WorkflowStep;
  box?: boolean;
  plain?: boolean;
  current?: boolean;
  onSelect?: (stage: string) => void;
}) {
  const className = box ? "workflow-graph-link workflow-graph-box" : "workflow-graph-link";
  const shared = {
    className,
    "data-map-stage": step.id,
    "data-stage-kind": step.kind,
    "data-optional": step.optional ? "true" : undefined,
  };
  const body = (
    <>
      {/* The legend explains the dot; the panel names the badge in words. */}
      {step.badges.includes("openspec") ? (
        <span className="workflow-graph-openspec" aria-hidden="true" />
      ) : null}
      {/* Inside the review group the group names the action, so only the artifact shows. */}
      {step.kind === "human" ? step.artifact : step.label}
    </>
  );
  if (plain) return <span {...shared}>{body}</span>;
  return (
    <button
      type="button"
      {...shared}
      aria-label={step.kind === "human" ? step.label : undefined}
      aria-current={current ? "true" : undefined}
      onClick={() => onSelect?.(step.id)}
    >
      {body}
    </button>
  );
}

/** One stage in the panel: what it does, how it runs, and the changes at it. */
function StageDetail({ step, changes }: { step: WorkflowStep; changes: string[] }) {
  return (
    <article
      className="workflow-card"
      data-stage={step.id}
      data-stage-kind={step.kind}
      data-optional={step.optional ? "true" : undefined}
    >
      <PanelHead
        title={step.label}
        kicker={
          <>
            <span>{PHASE_LABELS[step.phase]}</span>
            {step.optional ? <span>· optional</span> : null}
            {step.kind === "human" ? <span className="text-why">· human review</span> : null}
            {step.badges.includes("openspec") ? <span>· OpenSpec</span> : null}
          </>
        }
      >
        {step.skill || step.sessionBreakBefore ? (
          <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted">
            {step.skill ? <code className="font-mono text-text">{step.skill}</code> : null}
            {step.sessionBreakBefore ? (
              <span className="workflow-card-session inline-flex items-center gap-1.5 text-accent">
                <span
                  className="size-2 rounded-full border-[1.5px] border-accent"
                  aria-hidden="true"
                />
                New session / clean chat
              </span>
            ) : null}
          </p>
        ) : null}
      </PanelHead>
      <PanelSection title={step.kind === "human" ? "How it runs" : "Run"}>
        <StageRun step={step} />
        {step.missingSkill ? (
          <p className="workflow-missing-skill m-0 text-sm text-warn" role="note">
            Skill not reported for this companion:{" "}
            <code className="font-mono">{step.missingSkill}</code>. Run{" "}
            <code className="font-mono">mate companion update</code>; this stage is not complete.
          </p>
        ) : null}
      </PanelSection>
      <PanelSection title="What">
        <p className="m-0 text-sm leading-relaxed">{step.what}</p>
      </PanelSection>
      <PanelSection title="Why">
        <p className="m-0 text-sm leading-relaxed">{step.why}</p>
      </PanelSection>
      {changes.length > 0 ? (
        <PanelSection title="Changes at this stage" aside={String(changes.length)}>
          <ul className="m-0 grid list-none gap-1 p-0">
            {changes.map((name) => (
              <li key={name} className="truncate font-mono text-sm">
                {name}
              </li>
            ))}
          </ul>
        </PanelSection>
      ) : null}
    </article>
  );
}

/** How a stage runs: a person's review, a choice of prompts, or its one prompt. */
function StageRun({ step }: { step: WorkflowStep }) {
  if (step.kind === "human") {
    return (
      <p className="workflow-card-human m-0 text-sm">
        Review {step.artifact} yourself — no skill, no prompt
      </p>
    );
  }
  if (step.alternatives?.length) {
    return (
      <div className="workflow-option-list grid gap-3">
        {step.alternatives.map((alternative) => (
          <div key={alternative.name} className="workflow-option grid gap-1.5">
            <CommandLine
              text={alternative.prompt}
              copy={alternative.copyPrompt}
              label={`${alternative.name} prompt`}
            />
            <small className="text-xs text-muted">{alternative.description}</small>
          </div>
        ))}
      </div>
    );
  }
  if (!step.prompt) return null;
  return (
    <CommandLine
      text={step.prompt}
      copy={step.copyPrompt ?? step.prompt}
      label={`${step.label} prompt`}
    />
  );
}
