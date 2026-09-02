/** @jsxImportSource hono/jsx */

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

  return (
    <form className="sidebar-scope" method="get" action="/">
      <span className="sidebar-label">Scope</span>
      {selection.view === "dashboard" ? null : (
        <input type="hidden" name="view" value={selection.view} />
      )}
      {/* eslint-disable-next-line react/no-unknown-property -- raw HTML attribute: hono/jsx server-renders this inline handler */}
      <select name="companion" aria-label="Companion Repository" onchange="this.form.submit()">
        {companions.length === 0 ? <option value="">no companion registered</option> : null}
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
      <SelectorNote inventory={inventory} selection={selection} />
    </form>
  );
}

function SelectorNote({ inventory, selection }: CompanionSelectorProps) {
  const selected = resolveCompanion(inventory, selection.companionDigest);
  if (!selected) {
    return (
      <p className="note">
        {inventory.companions.length === 0
          ? "No Companion Repository is registered on this machine."
          : "Select a Companion Repository to see its state."}
      </p>
    );
  }
  const note = healthNote(selected);
  return note ? <p className="note unready">{note}</p> : null;
}
