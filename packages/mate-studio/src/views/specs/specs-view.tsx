import { Fragment } from "react";
import {
  type SpecActionOffer,
  type StudioCompanionPayload,
  type StudioSpec,
  SUBJECT_PATTERN,
} from "@uniqbit/mate-core/studio";
import { Warnings } from "../warnings";
import { groupSpecsByArea } from "./spec-areas";

const NO_ACTIONS: SpecActionOffer[] = [];

function specStatus(spec: StudioSpec): { label: string; invalid: boolean } {
  if (spec.valid === false) return { label: `${spec.issueCount ?? 0} issues`, invalid: true };
  if (spec.valid === true) return { label: "valid", invalid: false };
  return { label: "unvalidated", invalid: false };
}

interface SpecsProps {
  payload: Pick<StudioCompanionPayload, "specs" | "warnings">;
  /** Skill actions offered on each spec row; none by default. */
  actions?: SpecActionOffer[];
}

/** Its own view: an Area map is read on its own, not alongside the changes. */
export function Specs({ payload, actions = NO_ACTIONS }: SpecsProps) {
  return (
    <>
      <SpecsByArea specs={payload.specs} actions={actions} />
      <Warnings warnings={payload.warnings} />
    </>
  );
}

function SpecActions({ capability, actions }: { capability: string; actions: SpecActionOffer[] }) {
  if (!SUBJECT_PATTERN.test(capability)) return null;
  return (
    <span className="spec-actions">
      {actions.map(({ action, runAgents, copyAgents }) => (
        <Fragment key={action.id}>
          {runAgents.length > 0 ? (
            <button
              type="button"
              className="button spec-action"
              data-studio-action={action.id}
              data-studio-subject={capability}
              data-studio-agents={runAgents.join(" ")}
            >
              {action.label}
            </button>
          ) : null}
          <button
            type="button"
            className="runway-step-copy spec-copy"
            aria-label="Copy prompt"
            title="Copy prompt"
            data-studio-copy-prompt={action.id}
            data-prompt-claude={
              copyAgents.includes("claude") ? action.prompts.claude(capability) : undefined
            }
            data-prompt-opencode={
              copyAgents.includes("opencode") ? action.prompts.opencode(capability) : undefined
            }
          >
            <svg
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4" />
            </svg>
          </button>
        </Fragment>
      ))}
    </span>
  );
}

function SpecsByArea({ specs, actions }: { specs: StudioSpec[]; actions: SpecActionOffer[] }) {
  const groups = groupSpecsByArea(specs);

  return (
    <section className="view-section" aria-label="Specs by Area">
      <p className="view-summary">
        {specs.length} {specs.length === 1 ? "spec" : "specs"} · capabilities grouped by the Areas
        they serve
      </p>
      {groups.length === 0 ? (
        <p className="empty">No specs in this companion.</p>
      ) : (
        <div className="specs-area-grid">
          {groups.map(([area, areaSpecs]) => (
            <section key={area} className="specs-area-card" aria-label={`Area ${area}`}>
              <div className="specs-area-card-head">
                <h4 className="specs-area-name">{area}</h4>
                <span className="specs-area-count">{`${areaSpecs.length} specs`}</span>
              </div>
              <div className="specs-card-list">
                {areaSpecs.map((spec) => {
                  const status = specStatus(spec);
                  return (
                    <div key={spec.capability} className="spec-card-row">
                      <div>
                        <strong>{spec.capability}</strong>
                        <div className="spec-card-meta">
                          <span>
                            {spec.requirementCount === undefined
                              ? "requirements unknown"
                              : `${spec.requirementCount} requirements`}
                          </span>
                        </div>
                      </div>
                      <span className="spec-card-end">
                        <SpecActions capability={spec.capability} actions={actions} />
                        <span
                          className={
                            status.invalid ? "spec-status spec-status-invalid" : "spec-status"
                          }
                        >
                          {status.label}
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
