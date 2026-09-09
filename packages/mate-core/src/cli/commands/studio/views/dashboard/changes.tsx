/** @jsxImportSource hono/jsx */

import type { StudioChange } from "../../payload";

interface ChangesProps {
  changes: StudioChange[];
}

function progressLabel(change: StudioChange): string {
  const total = change.totalTasks ?? 0;
  return total === 0 ? "no tasks" : `${change.completedTasks ?? 0} / ${total}`;
}

function progressPercent(change: StudioChange): number {
  const total = change.totalTasks ?? 0;
  if (total === 0) return 0;
  return Math.min(100, Math.round(((change.completedTasks ?? 0) / total) * 100));
}

export function Changes({ changes }: ChangesProps) {
  return (
    <section className="panel lookup-panel">
      <div className="section-header">
        <div>
          <h3>Changes</h3>
          <p className="section-note">Active work tracked by this Companion Repository.</p>
        </div>
        <span className="section-count">
          {changes.length} {changes.length === 1 ? "change" : "changes"}
        </span>
      </div>
      {changes.length === 0 ? (
        <p className="empty">No changes in this companion.</p>
      ) : (
        <div className="scroll">
          <table className="lookup-table">
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Status</th>
                <th scope="col">Progress</th>
                <th scope="col">Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.name}>
                  <td data-label="Change">
                    <div className="change-cell">
                      <span className="mono">{change.name}</span>
                      {change.valid === false ? (
                        <span className="chip chip-invalid">
                          {`${change.issueCount ?? 0} issues`}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td data-label="Status">
                    <span className="status-chip" data-status={change.status ?? "unknown"}>
                      {change.status ?? "unknown"}
                    </span>
                  </td>
                  <td className="numeric" data-label="Progress">
                    <span className="progress-label">{progressLabel(change)}</span>
                    {(change.totalTasks ?? 0) === 0 ? null : (
                      <span
                        className="bar"
                        role="progressbar"
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={progressPercent(change)}
                        aria-label={`${progressLabel(change)} tasks complete`}
                      >
                        <span
                          className="bar-fill"
                          style={{ width: `${progressPercent(change)}%` }}
                        />
                      </span>
                    )}
                  </td>
                  <td data-label="Artifacts">
                    {change.artifacts.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="artifact-list">
                        {change.artifacts.map((artifact) => (
                          <span
                            key={artifact.id}
                            className={
                              artifact.status === "done" ? "chip chip-done" : "chip chip-pending"
                            }
                          >
                            {artifact.id}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
