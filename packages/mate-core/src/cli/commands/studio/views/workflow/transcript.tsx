/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import {
  workflowPlan,
  type WorkflowBranch,
  type WorkflowStep,
  type WorkflowStepBadge,
} from "./steps";

type WorkflowPlan = ReturnType<typeof workflowPlan>;

export function WorkflowTranscript({ payload }: { payload: StudioCompanionPayload }) {
  return <CommandTranscript plan={workflowPlan(payload.skills)} />;
}

function CommandTranscript({ plan }: { plan: WorkflowPlan }) {
  return (
    <section className="workflow-console" aria-label="Workflow execution map">
      <header className="workflow-console-header">
        <div className="workflow-console-header-title">
          <span>Workflow map</span>
          <strong>Companion delivery path</strong>
        </div>
        <span>Read-only guide</span>
      </header>
      <div className="workflow-console-body">
        <ConsoleLine step={plan.start} marker="01" />
        <div className="workflow-console-context">
          <span>precondition</span>
          <div>
            <p>The desired change, its scope, and the risk involved are clear.</p>
            <small>If any of that is unclear, pre-explore above resolves it first.</small>
          </div>
        </div>
        <div className="workflow-console-schema" data-workflow-schema-root>
          <div
            className="workflow-console-tabs"
            data-workflow-schema-switch
            role="tablist"
            aria-label="Planning depth"
          >
            {plan.branches.map((branch, index) => (
              <button
                key={branch.profile}
                type="button"
                role="tab"
                data-workflow-schema-profile={branch.profile}
                aria-selected={index === 0}
              >
                <strong>{branch.label}</strong>
                <small>{index === 0 ? "full planning" : "minimal planning"}</small>
              </button>
            ))}
          </div>
          <div className="workflow-console-panels">
            {plan.branches.map((branch, branchIndex) => (
              <section
                key={branch.profile}
                data-workflow-schema-panel={branch.profile}
                data-active={branchIndex === 0 ? "true" : "false"}
                role="tabpanel"
              >
                <div className="workflow-console-branch-rule">
                  <p className="workflow-console-branch-rule-description">
                    {planningRule(branch.profile)}
                  </p>
                </div>
                {branch.steps.map((step, index) => (
                  <div key={step.id}>
                    {step.sessionBreakBefore ? <WorkflowSessionBreak /> : null}
                    <ConsoleLine
                      step={step}
                      marker={`${branchIndex === 0 ? "F" : "M"}${String(index + 1).padStart(2, "0")}`}
                    />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
        <div className="workflow-console-divider">paths rejoin</div>
        {plan.shared.map((step) => (
          <div key={step.id}>
            {step.sessionBreakBefore ? <WorkflowSessionBreak /> : null}
            <ConsoleLine step={step} marker="+" />
          </div>
        ))}
        <div className="workflow-console-divider">feature is on production</div>
        <ConsoleLine step={plan.finish} marker="END" />
      </div>
    </section>
  );
}

function planningRule(profile: WorkflowBranch["profile"]): string {
  return profile === "mate-v1"
    ? "Use when intent is clear, but the solution, repository evidence, or risk still needs exploration."
    : "Use only when intent and scope are clear, the change is low-risk, and it stays within one Area.";
}

function ConsoleLine({ step, marker }: { step: WorkflowStep; marker: string }) {
  const hasAlternatives = Boolean(step.alternatives?.length);

  return (
    <article className="workflow-console-line">
      <span className="workflow-console-gutter">{marker}</span>
      <div className="workflow-console-line-body">
        <div className="workflow-console-step-title">
          <strong>{step.title}</strong>
          <WorkflowBadges badges={step.badges} />
        </div>
        {!hasAlternatives ? (
          step.kind === "review" ? (
            <div className="workflow-console-command workflow-console-review">
              <span className="workflow-console-command-label">Review</span>
              <code>{step.prompt}</code>
            </div>
          ) : (
            <div className="workflow-console-command">
              <span className="workflow-console-command-label">Run</span>
              <code>{step.prompt}</code>
              <WorkflowCopy text={step.copyPrompt} label={`${step.title} prompt`} />
            </div>
          )
        ) : null}
        {hasAlternatives ? <WorkflowOptions step={step} /> : null}
        <div className="workflow-console-explanation">
          <div className="workflow-console-detail">
            <span>What</span>
            <p>{step.what}</p>
          </div>
          <div className="workflow-console-detail">
            <span>Why</span>
            <small>{step.why}</small>
          </div>
        </div>
        {!hasAlternatives ? <WorkflowOptions step={step} /> : null}
      </div>
    </article>
  );
}

function WorkflowOptions({ step }: { step: WorkflowStep }) {
  if (!step.alternatives?.length) return null;
  return (
    <div className="workflow-option-list">
      {step.alternatives.map((alternative) => (
        <div key={alternative.name} className="workflow-option">
          <div className="workflow-console-command">
            <span className="workflow-console-command-label">Option</span>
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

function WorkflowSessionBreak() {
  return <div className="workflow-session-break">New session / clean chat</div>;
}

function WorkflowBadges({ badges }: { badges: WorkflowStepBadge[] }) {
  return (
    <span className="workflow-badges">
      {badges.map((badge) => (
        <em key={badge} className={`runway-step-badge runway-step-badge-${badge}`}>
          {badgeLabel(badge)}
        </em>
      ))}
    </span>
  );
}

function badgeLabel(badge: WorkflowStepBadge): string {
  if (badge === "human-in-loop") return "Review";
  if (badge === "openspec") return "OpenSpec";
  return badge;
}
