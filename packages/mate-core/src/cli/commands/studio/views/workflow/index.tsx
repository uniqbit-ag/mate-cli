/** @jsxImportSource hono/jsx */

import type { StudioCompanionPayload } from "../../payload";
import { Warnings } from "../warnings";
import { workflowSteps, type WorkflowStep } from "./steps";

interface WorkflowProps {
  payload: StudioCompanionPayload;
}

export function Workflow({ payload }: WorkflowProps) {
  const steps = workflowSteps();
  return (
    <>
      <div className="workflow-runway">
        <header className="runway-header">
          <h2>Workflow</h2>
        </header>

        <section className="runway-track">
          <div className="runway-track-head">
            <span className="workflow-eyebrow">Execution order</span>
            <span className="workflow-subtle">{`${steps.length} stages`}</span>
          </div>
          {steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </section>
      </div>
      <Warnings warnings={payload.warnings} />
    </>
  );
}

function Step({ step }: { step: WorkflowStep }) {
  return (
    <article className="runway-step">
      <span className="runway-step-index">{String(step.step).padStart(2, "0")}</span>
      <span className="runway-step-main">
        <span className="runway-step-title">
          <strong>{step.title}</strong>
          {step.optional ? <em className="runway-step-optional">Optional</em> : null}
        </span>
        <span className="runway-step-facets">
          <Facet kind="what" label="What" body={step.what} />
          <Facet kind="why" label="Why" body={step.why} />
        </span>
        <code>{step.prompt}</code>
      </span>
      <button
        type="button"
        className="runway-step-copy"
        data-copy={step.prompt}
        data-copy-label={`${step.title} prompt`}
      >
        Copy prompt
      </button>
    </article>
  );
}

function Facet({ kind, label, body }: { kind: "what" | "why"; label: string; body: string }) {
  return (
    <span className={`runway-step-facet runway-step-${kind}`}>
      <strong>{label}</strong>
      <span>{body}</span>
    </span>
  );
}
