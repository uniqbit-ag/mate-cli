import { useNavigate } from "@tanstack/react-router";

import type { StudioSearch } from "../lib/search";
import type { ShellCompanion } from "../server/shell";

/** Kept short so a card leads with what distinguishes it, not the shared prefix. */
const PAIRING_CHIP_LIMIT = 3;

function companionName(companionPath: string): string {
  const segments = companionPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? companionPath;
}

/**
 * The main content while no companion is chosen: one card per companion, so the first choice
 * is a click on the thing being chosen rather than a trip through the sidebar select.
 */
export function CompanionPicker({ companions }: { companions: ShellCompanion[] }) {
  const navigate = useNavigate();
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
      <div className="picker-grid">
        {companions.map((companion) => (
          <button
            key={companion.digest}
            type="button"
            className="picker-card"
            data-unready={companion.unready ? "true" : undefined}
            onClick={() =>
              void navigate({
                to: ".",
                search: (previous: StudioSearch) => ({ ...previous, companion: companion.digest }),
              })
            }
          >
            <span className="picker-card-name">{companionName(companion.path)}</span>
            <span className="picker-card-path mono">{companion.path}</span>
            <span className="picker-card-meta">
              {companion.note ? <span className="chip chip-invalid">{companion.note}</span> : null}
              {companion.pairings.length === 0 ? (
                <span className="chip">no linked working repository</span>
              ) : (
                companion.pairings.slice(0, PAIRING_CHIP_LIMIT).map((pairing) => (
                  <span key={pairing} className="chip">
                    {pairing}
                  </span>
                ))
              )}
              {companion.pairings.length > PAIRING_CHIP_LIMIT ? (
                <span className="chip">+{companion.pairings.length - PAIRING_CHIP_LIMIT} more</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
