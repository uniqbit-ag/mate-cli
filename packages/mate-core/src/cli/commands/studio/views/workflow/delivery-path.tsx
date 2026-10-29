/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
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
import {
  PHASE_LABELS,
  workflowPlan,
  type WorkflowPath,
  type WorkflowStep,
  type WorkflowStepBadge,
} from "./steps";

export function DeliveryPathView({ payload }: { payload: StudioCompanionPayload }) {
  const plan = workflowPlan({
    skills: payload.skills && payload.skills.length > 0 ? payload.skills : undefined,
    topology: payload.topology,
  });

  return (
    <section className="workflow-delivery-path" aria-label="Delivery Path">
      {plan.paths.length > 1 ? (
        <div className="workflow-schema" data-workflow-schema-root>
          <label className="view-choice">
            <span>OpenSpec schema</span>
            <select data-workflow-schema-select>
              {plan.paths.map((path, index) => (
                <option key={path.schema} value={path.schema} selected={index === 0}>
                  {path.label} – {path.tagline}
                </option>
              ))}
            </select>
          </label>
          <div className="workflow-schema-panels">
            {plan.paths.map((path, index) => (
              <section
                key={path.schema}
                data-workflow-schema-panel={path.schema}
                data-active={index === 0 ? "true" : "false"}
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
 * Node links are the only announced part: their document order is the stage order. Bands,
 * edges, and marks are decorative and hidden from assistive technology.
 */
function WorkflowGraphView({ path }: { path: WorkflowPath }) {
  const graph = workflowGraph(path);
  return (
    <nav
      className="workflow-graph"
      aria-label="Delivery Path map"
      style={{ "--graph-columns": String(graph.columns), "--graph-rows": String(graph.rows) }}
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
              style={{
                "--graph-row": String(node.column + 1),
                "--graph-lane": String(node.row + 1),
                "--graph-span": String(node.rowSpan),
              }}
            >
              {node.kind === "stage" ? (
                <NodeLink path={path} step={node.step} box />
              ) : (
                <div className="workflow-graph-box workflow-graph-group" data-map-group="human">
                  <span className="workflow-graph-group-label">Human review</span>
                  <ol>
                    {node.steps.map((step) => (
                      <li key={step.id}>
                        <NodeLink path={path} step={step} />
                      </li>
                    ))}
                  </ol>
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

/** `box` marks a standalone node; links inside the review group share its box. */
function NodeLink({ path, step, box }: { path: WorkflowPath; step: WorkflowStep; box?: boolean }) {
  return (
    <a
      className={box ? "workflow-graph-link workflow-graph-box" : "workflow-graph-link"}
      href={`#${cardId(path, step)}`}
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
    </a>
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
