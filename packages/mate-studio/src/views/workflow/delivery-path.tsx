import { type StudioCompanionPayload } from "@uniqbit/mate-core/studio";
import {
  bandSpan,
  edgeMidpoint,
  edgePath,
  graphAcross,
  nodeCenter,
  percentOf,
  workflowGraph,
  type WorkflowGraph,
  type WorkflowGraphEdge,
} from "./graph";
import {
  PHASE_LABELS,
  type WorkflowPath,
  workflowPlan,
  type WorkflowStep,
  type WorkflowStepBadge,
} from "./steps";
import { useState, type CSSProperties, type ReactNode } from "react";

export function DeliveryPathView({
  payload,
}: {
  payload: Pick<StudioCompanionPayload, "skills" | "topology">;
}) {
  const plan = workflowPlan({
    skills: payload.skills && payload.skills.length > 0 ? payload.skills : undefined,
    topology: payload.topology,
  });
  const [schema, setSchema] = useState(plan.paths[0]?.schema);

  return (
    <section className="workflow-delivery-path" aria-label="Delivery Path">
      {plan.paths.length > 1 ? (
        <div className="workflow-schema" data-workflow-schema-root>
          <label className="view-choice">
            <span>OpenSpec schema</span>
            <select
              data-workflow-schema-select
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
            >
              {plan.paths.map((path) => (
                <option key={path.schema} value={path.schema}>
                  {path.label} – {path.tagline}
                </option>
              ))}
            </select>
          </label>
          <div className="workflow-schema-panels">
            {plan.paths.map((path) => (
              <section
                key={path.schema}
                data-workflow-schema-panel={path.schema}
                data-active={path.schema === schema ? "true" : "false"}
              >
                <PathBody path={path} />
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="workflow-schema">
          <p className="view-choice">
            <span>OpenSpec schema</span>
            <code>
              {plan.paths[0].label} – {plan.paths[0].tagline}
            </code>
          </p>
          <PathBody path={plan.paths[0]} />
        </div>
      )}
    </section>
  );
}

/**
 * The graph is the path; the side panel shows one stage at a time. A node link targets its
 * card, and CSS shows only the targeted card, so selection needs no script. With nothing
 * selected the panel shows the path overview.
 */
function PathBody({ path }: { path: WorkflowPath }) {
  return (
    <div className="workflow-path">
      <div className="workflow-path-graph">
        <WorkflowGraphView path={path} />
        <GraphLegend />
      </div>
      <aside className="workflow-detail" aria-label={`${path.label} stage details`}>
        <div className="workflow-detail-overview" id={overviewId(path)}>
          <p className="workflow-description">{path.description}</p>
          {!path.reviewsKnown ? (
            <p className="workflow-description">
              The schema&apos;s artifacts could not be read, so its review stages are unknown.
            </p>
          ) : null}
          <p className="workflow-description">
            A workset is one or more changes published together: after Archive change, start again
            at the top for the next change, and publish once they are archived.
          </p>
          <p className="workflow-detail-hint">
            Select a node in the graph to see what that stage does and the prompt that runs it.
          </p>
        </div>
        {path.steps.map((step) => (
          <StageCard key={step.id} path={path} step={step} />
        ))}
      </aside>
    </div>
  );
}

const cardId = (path: WorkflowPath, step: WorkflowStep): string =>
  `workflow-${path.schema}-${step.id}`;

const overviewId = (path: WorkflowPath): string => `workflow-${path.schema}-overview`;

/**
 * Where one item is on the path: the node it is at (a stage id, or `reviews` for the review
 * group), or `complete` past the end. Nodes before it are done.
 */
export interface GraphProgress {
  current: string;
  /** How the current stage stands, e.g. `running`; styles the current node. */
  activity: string;
  /** A word or two under the current node, e.g. `running · 8m`. */
  note?: string;
}

type NodeProgress = "done" | "current" | "next";

/** Each node's progress, by column: everything left of the current node is done. */
function progressOf(
  graph: WorkflowGraph,
  progress: GraphProgress | undefined,
): (node: { id: string; column: number }) => NodeProgress | undefined {
  if (!progress) return () => undefined;
  const at = currentColumn(graph, progress.current);
  return (node) => {
    if (node.column < at) return "done";
    return node.id === progress.current ? "current" : "next";
  };
}

/** The current node's column; past the last column when `complete`. */
function currentColumn(graph: WorkflowGraph, current: string): number {
  const found = graph.nodes.find((node) => node.id === current);
  if (found) return found.column;
  if (current === "complete") return graph.columns;
  // A node this path lacks (reviews of an unreadable schema) marks nothing.
  return -1;
}

/**
 * Node links are the only announced part: their document order is the stage order. Bands,
 * edges, and marks are decorative and hidden from assistive technology. With `progress` the
 * map shows one item's position, and nodes are plain labels rather than stage-card links.
 */
export function WorkflowGraphView({
  path,
  progress,
  label = "Delivery Path map",
}: {
  path: WorkflowPath;
  progress?: GraphProgress;
  label?: string;
}) {
  const graph = workflowGraph(path);
  const stateOf = progressOf(graph, progress);
  return (
    <nav
      className="workflow-graph"
      aria-label={label}
      data-progress-activity={progress?.activity}
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
      <GraphLayer graph={graph} stateOf={stateOf} />
      <ol className="workflow-graph-nodes">
        {graph.nodes.map((node) =>
          node.kind === "start" ? null : (
            <li
              key={node.id}
              className="workflow-graph-node"
              data-node-kind={node.kind}
              data-progress={stateOf(node)}
              aria-current={stateOf(node) === "current" ? "step" : undefined}
              style={
                {
                  "--graph-row": String(node.column + 1),
                  "--graph-lane": String(node.row + 1),
                  "--graph-span": String(node.rowSpan),
                } as CSSProperties
              }
            >
              {node.kind === "stage" ? (
                <NodeLink path={path} step={node.step} box plain={Boolean(progress)}>
                  <ProgressNote progress={progress} state={stateOf(node)} />
                </NodeLink>
              ) : (
                <div className="workflow-graph-box workflow-graph-group" data-map-group="human">
                  <span className="workflow-graph-group-label">Human review</span>
                  <ol>
                    {node.steps.map((step) => (
                      <li key={step.id}>
                        <NodeLink path={path} step={step} plain={Boolean(progress)} />
                      </li>
                    ))}
                  </ol>
                  <ProgressNote progress={progress} state={stateOf(node)} />
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

/** The current node's note, plus the done mark for assistive technology. */
function ProgressNote({
  progress,
  state,
}: {
  progress: GraphProgress | undefined;
  state: NodeProgress | undefined;
}) {
  if (state === "done") return <span className="visually-hidden">, done</span>;
  if (state !== "current" || !progress?.note) return null;
  return <span className="workflow-graph-note">{progress.note}</span>;
}

function GraphLayer({
  graph,
  stateOf,
}: {
  graph: WorkflowGraph;
  stateOf: ReturnType<typeof progressOf>;
}) {
  /** A flow edge into a done or current node is the way the item came. */
  const travelled = (edge: WorkflowGraphEdge): boolean => {
    const to = graph.nodes.find((node) => node.id === edge.to);
    const state = to ? stateOf(to) : undefined;
    return edge.kind === "flow" && (state === "done" || state === "current");
  };
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
            data-travelled={travelled(edge) ? "true" : undefined}
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
 * `box` marks a standalone node; links inside the review group share its box. `plain` renders
 * a label without a link, for a map with no stage cards beside it.
 */
function NodeLink({
  path,
  step,
  box,
  plain,
  children,
}: {
  path: WorkflowPath;
  step: WorkflowStep;
  box?: boolean;
  plain?: boolean;
  children?: ReactNode;
}) {
  const Tag = plain ? "span" : "a";
  return (
    <Tag
      className={box ? "workflow-graph-link workflow-graph-box" : "workflow-graph-link"}
      href={plain ? undefined : `#${cardId(path, step)}`}
      data-map-stage={step.id}
      data-stage-kind={step.kind}
      data-optional={step.optional ? "true" : undefined}
      aria-label={step.kind === "human" ? step.label : undefined}
    >
      {/* The legend explains the dot; the panel names the badge in words. */}
      {step.badges.includes("openspec") ? (
        <span className="workflow-graph-openspec" aria-hidden="true" />
      ) : null}
      {/* Inside the review group the group names the action, so only the artifact shows. */}
      {step.kind === "human" ? step.artifact : step.label}
      {children}
    </Tag>
  );
}

function StageCard({ path, step }: { path: WorkflowPath; step: WorkflowStep }) {
  return (
    <article
      className="workflow-card"
      id={cardId(path, step)}
      data-stage={step.id}
      data-stage-kind={step.kind}
      data-optional={step.optional ? "true" : undefined}
    >
      <header className="workflow-card-header">
        <div className="workflow-card-heading">
          <h3>{step.label}</h3>
          <WorkflowBadges badges={shownBadges(step)} />
        </div>
        <p className="workflow-card-meta">
          <span>{PHASE_LABELS[step.phase]}</span>
          {step.skill ? <code>{step.skill}</code> : null}
          {step.sessionBreakBefore ? (
            <span className="workflow-card-session">New session / clean chat</span>
          ) : null}
        </p>
      </header>
      <StageRun step={step} />
      {step.missingSkill ? (
        <p className="workflow-missing-skill" role="note">
          Skill not reported for this companion: <code>{step.missingSkill}</code>. Run{" "}
          <code>mate companion update</code>; this stage is not complete.
        </p>
      ) : null}
      <dl className="workflow-card-explanation">
        <div>
          <dt>What</dt>
          <dd>{step.what}</dd>
        </div>
        <div>
          <dt>Why</dt>
          <dd>{step.why}</dd>
        </div>
      </dl>
      <footer className="workflow-card-footer">
        <a href={`#${overviewId(path)}`}>Path overview</a>
      </footer>
    </article>
  );
}

/** How a stage runs: a person's review, a choice of prompts, or its one prompt. */
function StageRun({ step }: { step: WorkflowStep }) {
  if (step.kind === "human") {
    return (
      <p className="workflow-card-human">Review {step.artifact} yourself — no skill, no prompt</p>
    );
  }
  if (step.alternatives?.length) return <WorkflowOptions step={step} />;
  if (!step.prompt) return null;
  return (
    <div className="workflow-command">
      <span className="workflow-command-label">Run</span>
      <code>{step.prompt}</code>
      <WorkflowCopy text={step.copyPrompt ?? step.prompt} label={`${step.label} prompt`} />
    </div>
  );
}

function WorkflowOptions({ step }: { step: WorkflowStep }) {
  if (!step.alternatives?.length) return null;
  return (
    <div className="workflow-option-list">
      {step.alternatives.map((alternative) => (
        <div key={alternative.name} className="workflow-option">
          <div className="workflow-command">
            <span className="workflow-command-label">Option</span>
            <code>{alternative.prompt}</code>
            <WorkflowCopy text={alternative.copyPrompt} label={`${alternative.name} prompt`} />
          </div>
          <small>{alternative.description}</small>
        </div>
      ))}
    </div>
  );
}

function WorkflowCopy({ text, label }: { text: string; label: string }) {
  return (
    <button type="button" className="runway-step-copy" data-copy={text} data-copy-label={label}>
      Copy
    </button>
  );
}

/** The skill name already says a stage is a skill stage, so that badge is not shown. */
const shownBadges = (step: WorkflowStep): WorkflowStepBadge[] =>
  step.badges.filter((badge) => badge !== "skill");

function WorkflowBadges({ badges }: { badges: WorkflowStepBadge[] }) {
  return (
    <span className="workflow-badges">
      {badges.map((badge) => (
        <em key={badge} className={`runway-step-badge runway-step-badge-${badge}`}>
          {badge === "human-review" ? "Human review" : badge}
        </em>
      ))}
    </span>
  );
}
