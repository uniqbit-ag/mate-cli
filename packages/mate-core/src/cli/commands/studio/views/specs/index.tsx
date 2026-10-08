/** @jsxImportSource hono/jsx */

import { SUBJECT_PATTERN, type SpecActionOffer } from "../../actions";
import type { StudioCompanionPayload, StudioSpec } from "../../payload";
import { Warnings } from "../warnings";

const NO_ACTIONS: SpecActionOffer[] = [];
const UNASSIGNED_AREA = "unassigned";

/** A spec binds one Area or several, so it appears under each of them. */
export function groupSpecsByArea(specs: StudioSpec[]): [string, StudioSpec[]][] {
  const groups = new Map<string, StudioSpec[]>();
  for (const spec of specs) {
    const areas = spec.areas.length > 0 ? spec.areas : [UNASSIGNED_AREA];
    for (const area of areas) {
      const existing = groups.get(area);
      if (existing) existing.push(spec);
      else groups.set(area, [spec]);
    }
  }
  return [...groups.entries()].toSorted((left, right) => left[0].localeCompare(right[0]));
}

function specStatus(spec: StudioSpec): { label: string; invalid: boolean } {
  if (spec.valid === false) return { label: `${spec.issueCount ?? 0} issues`, invalid: true };
  if (spec.valid === true) return { label: "valid", invalid: false };
  return { label: "unvalidated", invalid: false };
}

interface SpecsProps {
  payload: StudioCompanionPayload;
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
        <>
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
              stroke-width="1.5"
              aria-hidden="true"
            >
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4" />
            </svg>
          </button>
        </>
      ))}
    </span>
  );
}

function SpecsByArea({ specs, actions }: { specs: StudioSpec[]; actions: SpecActionOffer[] }) {
  const groups = groupSpecsByArea(specs);

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <h3>Specs by Area</h3>
          <p className="section-note">Capabilities grouped by the Areas they serve.</p>
        </div>
        <span className="section-count">
          {specs.length} {specs.length === 1 ? "spec" : "specs"}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="empty">No specs in this companion.</p>
      ) : (
        <div className="specs-area-grid">
          {groups.map(([area, areaSpecs], index) => (
            <section key={area} className="specs-area-card" aria-label={`Area ${area}`}>
              <div className="specs-area-card-head">
                <div className="specs-area-name">
                  <span className="specs-area-number">{String(index + 1).padStart(2, "0")}</span>
                  <h4>{area}</h4>
                </div>
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
