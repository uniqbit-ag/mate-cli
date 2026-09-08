/** @jsxImportSource hono/jsx */

import type { StudioInventory, StudioInventoryCompanion } from "../inventory";
import { companionDigest, type StudioSelection } from "../selection";
import { healthNote } from "./model";

interface CompanionPickerProps {
  inventory: StudioInventory;
  selection: StudioSelection;
}

/** Kept short so a card leads with what distinguishes it, not the shared prefix. */
const PAIRING_CHIP_LIMIT = 3;

function companionName(companionPath: string): string {
  const segments = companionPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? companionPath;
}

/**
 * The unselected main content. One submit button per companion, so the first
 * choice is a click on the thing being chosen rather than a trip through the
 * sidebar dropdown — the same GET navigation either way.
 */
export function CompanionPicker({ inventory, selection }: CompanionPickerProps) {
  const companions = inventory.companions;

  if (companions.length === 0) {
    return (
      <section className="panel">
        <h3>No Companion Repository</h3>
        <p className="empty">No Companion Repository is registered on this machine.</p>
        <p className="muted">
          Run <span className="mono">mate companion setup</span> in a Working Repository to register
          one.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h3>Choose a Companion Repository</h3>
      <p className="note">
        Studio serves one companion at a time, and remembers the one you choose for your next visit.
      </p>
      <form method="get" action="/">
        {selection.view === "dashboard" ? null : (
          <input type="hidden" name="view" value={selection.view} />
        )}
        <div className="picker-grid">
          {companions.map((companion) => (
            <CompanionCard key={companionDigest(companion.path)} companion={companion} />
          ))}
        </div>
      </form>
    </section>
  );
}

function CompanionCard({ companion }: { companion: StudioInventoryCompanion }) {
  const note = healthNote(companion);
  const pairings = companion.pairings.slice(0, PAIRING_CHIP_LIMIT);
  const hidden = companion.pairings.length - pairings.length;

  return (
    <button
      type="submit"
      name="companion"
      value={companionDigest(companion.path)}
      className="picker-card"
      data-unready={companion.health === "ready" ? undefined : "true"}
    >
      <span className="picker-card-name">{companionName(companion.path)}</span>
      <span className="picker-card-path mono">{companion.path}</span>
      <span className="picker-card-meta">
        {note ? <span className="chip chip-invalid">{note}</span> : null}
        {companion.pairings.length === 0 ? (
          <span className="chip">no linked working repository</span>
        ) : (
          pairings.map((pairing) => (
            <span key={pairing.repositoryPath} className="chip">
              {pairing.repositoryId}
            </span>
          ))
        )}
        {hidden > 0 ? <span className="chip">+{hidden} more</span> : null}
      </span>
    </button>
  );
}
