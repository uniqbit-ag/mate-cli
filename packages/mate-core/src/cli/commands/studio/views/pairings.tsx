/** @jsxImportSource hono/jsx */

import type { StudioInventoryCompanion } from "../inventory";

interface PairingsProps {
  companion: StudioInventoryCompanion | null;
}

/**
 * Context, never a selection: everything Studio serves is companion-scoped, so
 * a Working Repository is listed and never chosen.
 */
export function Pairings({ companion }: PairingsProps) {
  const pairings = companion?.pairings ?? [];

  return (
    <div className="sidebar-pairings">
      <span className="sidebar-label">Working repositories</span>
      {pairings.length === 0 ? (
        <p className="empty">no linked working repository</p>
      ) : (
        <ul className="plain pairings">
          {pairings.map((pairing) => (
            <li key={pairing.repositoryPath} data-repository={pairing.repositoryPath}>
              <span className="mono">{pairing.repositoryId}</span>
              {pairing.ambiguous ? <span className="chip">also paired elsewhere</span> : null}
              {pairing.health === "ready" ? null : (
                <span className="chip chip-invalid">{pairing.health}</span>
              )}
              <br />
              <span className="muted">{pairing.repositoryPath}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
