/** @jsxImportSource hono/jsx */

import type { StudioSpec } from "../../payload";

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
  specs: StudioSpec[];
}

export function Specs({ specs }: SpecsProps) {
  const groups = groupSpecsByArea(specs);

  return (
    <section className="panel">
      <h3>Specs by Area</h3>
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
                      <span
                        className={
                          status.invalid ? "spec-status spec-status-invalid" : "spec-status"
                        }
                      >
                        {status.label}
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
