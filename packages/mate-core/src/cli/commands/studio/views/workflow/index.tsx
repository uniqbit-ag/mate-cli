/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import {
  workflowPlan,
  type WorkflowAlternative,
  type WorkflowBranch,
  type WorkflowStep,
  type WorkflowStepBadge,
} from "./steps";

interface WorkflowProps {
  payload: StudioCompanionPayload;
}

export function Workflow({ payload }: WorkflowProps) {
  const plan = workflowPlan(payload.skills);
  const longestPath = Math.max(...plan.branches.map((branch) => branch.steps.length));
  const stageCount = longestPath + plan.shared.length + 3;

  return (
    <>
      <div className="workflow-runway">
        <header className="runway-header">
          <h2>Workflow</h2>
        </header>

        <section className="runway-track">
          <div className="runway-track-head">
            <span className="workflow-eyebrow">Execution order</span>
            <span className="workflow-subtle">{`${stageCount} stages · ${plan.branches.length} profiles`}</span>
          </div>

          <div className="workflow-flow">
            <Step marker="01" step={plan.start} edge="workflow-start" />
            <Connector />
            <SchemaSwitch branches={plan.branches} />
            <Connector />
            {plan.shared.map((step, index) => (
              <div key={step.id} className="workflow-shared-step">
                {step.sessionBreakBefore ? <SessionBreak /> : null}
                <Step marker={`S${index + 1}`} step={step} />
              </div>
            ))}
            <Connector />
            <Step marker="END" step={plan.finish} edge="workflow-finish" />
          </div>
        </section>
      </div>
      <Warnings warnings={payload.warnings} />
    </>
  );
}

function SchemaSwitch({ branches }: { branches: WorkflowBranch[] }) {
  return (
    <section className="workflow-choice" data-workflow-switch>
      <div className="workflow-switch-head">
        <span className="workflow-eyebrow">02 / choose a schema</span>
        <p>Pick one path. Both end at the same implementation, cleanup, and finish steps.</p>
      </div>
      <fieldset className="workflow-switch-options">
        <legend>Select a workflow profile</legend>
        {branches.map((branch, index) => (
          <label key={branch.profile} className="workflow-switch-option">
            <input
              type="radio"
              name="workflow-profile"
              value={branch.profile}
              data-workflow-profile
              defaultChecked={index === 0}
            />
            <span>
              <strong>{branch.label}</strong>
              <small>{branch.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="workflow-branches">
        {branches.map((branch, branchIndex) => (
          <article
            key={branch.profile}
            className="workflow-branch"
            data-workflow-branch={branch.profile}
            data-active={branchIndex === 0 ? "true" : "false"}
          >
            <header className="workflow-branch-head">
              <span className="workflow-eyebrow">{branch.label}</span>
              <span className="workflow-subtle">{`${branch.steps.length} path stages`}</span>
            </header>
            {branch.steps.map((step, index) => (
              <div key={`${branch.profile}-${step.id}`} className="workflow-branch-step">
                {step.sessionBreakBefore ? <SessionBreak /> : null}
                <Step marker={String(index + 3).padStart(2, "0")} step={step} />
                {index < branch.steps.length - 1 ? <Connector /> : null}
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function Connector() {
  return <span className="workflow-connector" aria-hidden="true" />;
}

function SessionBreak() {
  return (
    <div className="workflow-session-break" role="separator" aria-label="New Session or clean chat">
      <span>New Session or clean chat</span>
    </div>
  );
}

function Step({ step, marker, edge = "" }: { step: WorkflowStep; marker: string; edge?: string }) {
  return (
    <article className={`runway-step ${edge}`}>
      <span className="runway-step-index">{marker}</span>
      <div className="runway-step-main">
        <span className="runway-step-title">
          <strong>{step.title}</strong>
          {step.badges.map((badge) => (
            <Badge key={badge} badge={badge} />
          ))}
        </span>
        <span className="runway-step-facets">
          <Facet kind="what" label="What" body={step.what} />
          <Facet kind="why" label="Why" body={step.why} />
        </span>
        <div className="runway-step-prompt">
          <span className="workflow-prompt-label">
            {step.badges.includes("human-in-loop") ? "Human review" : "Prompt to agent"}
          </span>
          {step.alternatives ? (
            <Alternatives alternatives={step.alternatives} />
          ) : (
            <pre>
              <code>{step.prompt}</code>
            </pre>
          )}
        </div>
      </div>
      {step.badges.includes("human-in-loop") || step.alternatives ? null : (
        <button
          type="button"
          className="runway-step-copy"
          data-copy={step.copyPrompt}
          data-copy-label={`${step.title} prompt`}
        >
          Copy prompt
        </button>
      )}
    </article>
  );
}

function Alternatives({ alternatives }: { alternatives: WorkflowAlternative[] }) {
  return (
    <div className="workflow-alternatives">
      {alternatives.map((alternative) => (
        <div key={alternative.name} className="workflow-alternative">
          <div className="workflow-alternative-copy">
            <strong>{alternative.name}</strong>
            <small>{alternative.description}</small>
          </div>
          <pre>
            <code>{alternative.prompt}</code>
          </pre>
          <button
            type="button"
            className="runway-step-copy"
            data-copy={alternative.copyPrompt}
            data-copy-label={`${alternative.name} prompt`}
          >
            Copy prompt
          </button>
        </div>
      ))}
      <p className="workflow-skip" data-workflow-skip>
        Skip pre-explore: continue to the next workflow prompt without invoking a conversational
        skill.
      </p>
    </div>
  );
}

function Badge({ badge }: { badge: WorkflowStepBadge }) {
  const label =
    badge === "skill"
      ? "Skill"
      : badge === "openspec"
        ? "OpenSpec"
        : badge === "human-in-loop"
          ? "Human in the loop"
          : "Optional";
  return <em className={`runway-step-badge runway-step-badge-${badge}`}>{label}</em>;
}

function Facet({ kind, label, body }: { kind: "what" | "why"; label: string; body: string }) {
  return (
    <span className={`runway-step-facet runway-step-${kind}`}>
      <strong>{label}</strong>
      <span>{body}</span>
    </span>
  );
}
