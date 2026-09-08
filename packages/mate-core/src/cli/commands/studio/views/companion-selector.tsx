/** @jsxImportSource hono/jsx */

import type { StudioInventoryCompanion } from "../inventory";
import { companionDigest, resolveCompanion, type StudioSelection } from "../selection";
import { healthNote, type StudioPage } from "./model";

interface CompanionSelectorProps {
  inventory: StudioPage["inventory"];
  selection: StudioSelection;
}

/**
 * A GET form, so choosing a companion is a navigation to the URL naming it. The
 * change is deliberately not carried over: it belongs to the companion being
 * left behind.
 */
export function CompanionSelector({ inventory, selection }: CompanionSelectorProps) {
  const companions = inventory.companions;
  const selected = resolveCompanion(inventory, selection.companionDigest);

  return (
    <form className="sidebar-scope" method="get" action="/">
      <span className="sidebar-label">Scope</span>
      {selection.view === "dashboard" ? null : (
        <input type="hidden" name="view" value={selection.view} />
      )}
      {/* eslint-disable-next-line react/no-unknown-property -- raw HTML attribute: hono/jsx server-renders this inline handler */}
      <select name="companion" aria-label="Companion Repository" onchange="this.form.submit()">
        <PlaceholderOption companionCount={companions.length} selected={selected} />
        {companions.map((companion) => {
          const digest = companionDigest(companion.path);
          const note = healthNote(companion);
          const unready = companion.health !== "ready";
          return (
            <option
              key={digest}
              value={digest}
              selected={digest === selection.companionDigest}
              className={unready ? "unready" : undefined}
              data-unready={unready ? "true" : undefined}
            >
              {note ? `${companion.path} (${note})` : companion.path}
            </option>
          );
        })}
      </select>
      <SelectorNote companionCount={companions.length} selected={selected} />
    </form>
  );
}

interface EmptyStateProps {
  companionCount: number;
  selected: StudioInventoryCompanion | null;
}

/**
 * Without it the browser shows the first companion as if it were chosen, which
 * a null selection is not. Disabled so it cannot be chosen back, and dropped
 * once a companion resolves.
 */
function PlaceholderOption({ companionCount, selected }: EmptyStateProps) {
  if (companionCount === 0) {
    return (
      <option value="" className="placeholder">
        no companion registered
      </option>
    );
  }
  if (selected) return null;
  return (
    <option value="" selected disabled className="placeholder">
      select a companion…
    </option>
  );
}

function SelectorNote({ companionCount, selected }: EmptyStateProps) {
  if (!selected) {
    return (
      <p className="note">
        {companionCount === 0
          ? "No Companion Repository is registered on this machine."
          : "Select a Companion Repository to see its state."}
      </p>
    );
  }
  const note = healthNote(selected);
  return note ? <p className="note unready">{note}</p> : null;
}
