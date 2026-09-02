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
    <section className="panel">
      <h3>Changes</h3>
      {changes.length === 0 ? (
        <p className="empty">No changes in this companion.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Change</th>
                <th scope="col">Status</th>
                <th scope="col">Tasks</th>
                <th scope="col">Artifacts</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.name}>
                  <td>
                    <span className="mono">{change.name}</span>
                    {change.valid === false ? (
                      <span className="chip chip-invalid">
                        {`${change.issueCount ?? 0} issues`}
                      </span>
                    ) : null}
                  </td>
                  <td>{change.status ?? "unknown"}</td>
                  <td className="numeric">
                    {progressLabel(change)}
                    {(change.totalTasks ?? 0) === 0 ? null : (
                      <span className="bar">
                        <span
                          className="bar-fill"
                          style={{ width: `${progressPercent(change)}%` }}
                        />
                      </span>
                    )}
                  </td>
                  <td>
                    {change.artifacts.length === 0
                      ? "—"
                      : change.artifacts.map((artifact) => (
                          <span
                            key={artifact.id}
                            className={
                              artifact.status === "done" ? "chip chip-done" : "chip chip-pending"
                            }
                          >
                            {artifact.id}
                          </span>
                        ))}
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
