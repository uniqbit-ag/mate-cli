import { useEffect, useState } from "react";

import { inField } from "../../lib/in-field";

const SEEN_KEY = "mate.factory.needsYou";

/** Whether every word of `query` occurs in `text`, ignoring case. */
export function matchesFilter(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** The page title with the decision count in front, without stacking counts. */
export function titled(title: string, count: number): string {
  const bare = title.replace(/^\(\d+\) /, "");
  return count > 0 ? `(${count}) ${bare}` : bare;
}

/** The row `delta` steps from the focused one, held at the ends; the first row when none is. */
export function stepRow(
  rows: readonly Element[],
  focused: Element | null,
  delta: number,
): Element | undefined {
  const at = focused ? rows.indexOf(focused) : -1;
  if (at === -1) return rows[0];
  return rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
}

/** Whether a key press belongs to a field or the terminal rather than to a shortcut. */
function typing(target: EventTarget | null): boolean {
  return inField(target) || Boolean((target as Element | null)?.closest?.(".outcome-terminal"));
}

/** In an open Outcome panel: 1–9 pick a one-click answer, J/K the next or previous Outcome. */
function dialogButton(dialog: Element, key: string): HTMLButtonElement | null {
  if (/^[1-9]$/.test(key)) {
    return dialog.querySelector<HTMLButtonElement>(`[data-option-key="${key}"]`);
  }
  const step = ({ j: "Next", k: "Previous" } as Record<string, string>)[key];
  if (!step) return null;
  // The panel's own Previous and Next walk the Outcomes.
  return (dialog.closest("[data-slot=sheet-content]") ?? dialog).querySelector<HTMLButtonElement>(
    `button[aria-label="${step}"]`,
  );
}

/** On the board: N focuses the new-outcome field, / the filter. */
function boardField(doc: Document, key: string): HTMLElement | null {
  if (key === "n") return doc.querySelector<HTMLElement>("form[data-outcome-input] textarea");
  if (key === "/") return doc.querySelector<HTMLElement>("[data-outcome-filter]");
  return null;
}

/**
 * Board shortcuts: N starts a new outcome, / filters, J/K (arrows on a row) move between
 * rows, Enter opens one. In an open Outcome panel J/K step to the next or previous Outcome, 1–9
 * pick a one-click answer and Ctrl/Cmd+Enter sends the form being typed in. Fields and the
 * terminal keep every other key.
 */
export function factoryKeyHandler(doc: Document) {
  return (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey) return;
    const target = event.target as Element | null;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      const form = target?.closest?.("form");
      if (target?.localName === "textarea" && form) {
        event.preventDefault();
        // A round that is not fully answered yet is not sent.
        if (form.querySelector('button[type="submit"].factory-primary:disabled')) return;
        const start = form.querySelector<HTMLButtonElement>('button[value="start"]');
        (form as HTMLFormElement).requestSubmit(start ?? undefined);
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || typing(target)) return;
    // Another modal (Agents, the palette) owns the keys while focus is in it.
    const modal = target?.closest?.('[data-slot="sheet-content"], [data-slot="dialog-content"]');
    if (modal && !modal.querySelector("[data-outcome-panel]")) return;
    const dialog = doc.querySelector("[data-outcome-panel]");
    if (dialog) {
      const button = dialogButton(dialog, event.key);
      if (button) {
        event.preventDefault();
        button.click();
      }
      return;
    }
    const field = boardField(doc, event.key);
    if (field) {
      event.preventDefault();
      field.focus();
      return;
    }
    const onRow = Boolean(target?.matches?.("[data-outcome-row]"));
    const down = event.key === "j" || (onRow && event.key === "ArrowDown");
    const up = event.key === "k" || (onRow && event.key === "ArrowUp");
    if (!down && !up) return;
    // Rows folded away under "Show all" are skipped.
    const rows = [...doc.querySelectorAll("[data-outcome-row]")].filter(
      (row) => row.getClientRects().length > 0,
    );
    const next = stepRow(rows, doc.activeElement, down ? 1 : -1) as HTMLElement | undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };
}

export function useFactoryKeys(): void {
  useEffect(() => {
    const handler = factoryKeyHandler(document);
    // Capture: the Outcome panel stops keys from bubbling past it. On window, so it runs before
    // the palette's document listener, which leaves a "/" this handler took.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}

/** Puts the decision count in the title and notifies when it grows, once per count. */
export function useNeedsYou(count: number): void {
  useEffect(() => {
    document.title = titled(document.title, count);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    let seen = 0;
    try {
      seen = Number(sessionStorage.getItem(SEEN_KEY) || "0");
      sessionStorage.setItem(SEEN_KEY, String(count));
    } catch {
      /* a blocked store only costs the de-duplication */
    }
    if (count > seen) {
      new Notification("Mate factory", {
        body: count === 1 ? "1 decision needs you" : `${count} decisions need you`,
      });
    }
  }, [count]);
  useEffect(() => () => void (document.title = titled(document.title, 0)), []);
}

/** Whether to offer notifications: only while the browser has not been asked yet. */
export function useNotificationOffer(): { offered: boolean; ask(): void } {
  // Views render only in the browser, so the permission is read once, before the first paint.
  const [offered, setOffered] = useState(
    () => typeof Notification !== "undefined" && Notification.permission === "default",
  );
  return {
    offered,
    ask: () => void Notification.requestPermission().then(() => setOffered(false)),
  };
}
