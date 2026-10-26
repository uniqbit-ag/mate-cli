import { VAULT_TREE_STORAGE_KEY } from "./keys";
import { failure, fetchMarkup, isPlainClick, moveInto, navigate, wireNavigation } from "./page";

const FILTER_DELAY = 150;

let displayedGeneration: number | null = null;
let latestGeneration: number | null = null;
let refreshSequence = 0;
let filterSequence = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let filterRequest: AbortController | null = null;

function showTree(shown: boolean): void {
  const root = document.documentElement;
  if (shown) root.removeAttribute("data-vault-tree");
  else root.setAttribute("data-vault-tree", "hidden");
  const toggle = document.getElementById("vault-tree-toggle");
  if (toggle) {
    toggle.textContent = shown ? "Hide files" : "Show files";
    toggle.setAttribute("aria-expanded", shown ? "true" : "false");
  }
  try {
    localStorage.setItem(VAULT_TREE_STORAGE_KEY, shown ? "shown" : "hidden");
  } catch {
    /* a blocked web store only costs the preference, never the page */
  }
}

function readGeneration(slot: Element | null): number | null {
  const value = slot ? slot.getAttribute("data-vault-generation") : null;
  return value === null || value === "" ? null : Number(value);
}

/** The indicator clears only once the displayed listing is as new as the newest change seen. */
function showStale(): void {
  const note = document.getElementById("vault-stale");
  if (!note) return;
  note.hidden = !(
    latestGeneration !== null &&
    displayedGeneration !== null &&
    latestGeneration > displayedGeneration
  );
}

function openedByViewer(): (string | null)[] {
  return Array.from(document.querySelectorAll("details[data-vault-children-url][open]"), (folder) =>
    folder.getAttribute("data-vault-dir"),
  );
}

/** Swaps server-rendered parts into place; a refreshed tree drops loaded folders and reopens the viewer's. */
function swapVaultSlots(markup: string): void {
  const reopen = openedByViewer();
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  parsed.querySelectorAll("[data-vault-slot]").forEach((slot) => {
    const name = slot.getAttribute("data-vault-slot");
    const target = document.querySelector(`[data-vault-slot="${name}"]`);
    if (!target) return;
    const node = document.importNode(slot, true) as Element;
    target.replaceWith(node);
    wireNavigation(node);
    if (name !== "tree") return;
    displayedGeneration = readGeneration(node);
    node
      .querySelectorAll<HTMLDetailsElement>("details[data-vault-children-url]")
      .forEach((folder) => {
        if (reopen.includes(folder.getAttribute("data-vault-dir"))) folder.open = true;
      });
  });
  showStale();
  runFilter();
}

function failVaultSlots(message: string): void {
  document.querySelectorAll("[data-vault-slot][aria-busy]").forEach((slot) => {
    slot.removeAttribute("aria-busy");
    slot.textContent = message;
  });
}

function loadChildren(folder: Element): void {
  const url = folder.getAttribute("data-vault-children-url");
  const container = folder.querySelector(".vault-children");
  if (
    !url ||
    !container ||
    folder.hasAttribute("data-vault-loaded") ||
    folder.hasAttribute("data-vault-loading")
  ) {
    return;
  }
  folder.setAttribute("data-vault-loading", "");
  fetchMarkup(url)
    .then((markup) => {
      moveInto(container, markup);
      folder.setAttribute("data-vault-loaded", "");
    })
    .catch((error) => {
      container.textContent = `This folder could not be loaded: ${failure(error)}`;
    })
    .finally(() => {
      folder.removeAttribute("data-vault-loading");
    });
}

function runFilter(): void {
  const filter = document.getElementById("vault-filter") as HTMLInputElement | null;
  const results = document.getElementById("vault-filter-results");
  const panel = document.getElementById("vault-tree-panel");
  const layout = document.querySelector("[data-vault-layout]");
  if (!filter || !results || !panel || !layout) return;
  clearTimeout(filterTimer);
  if (filterRequest) filterRequest.abort();
  const needle = filter.value.trim();
  filterSequence += 1;
  if (!needle) {
    results.hidden = true;
    results.replaceChildren();
    panel.removeAttribute("data-vault-filtering");
    return;
  }
  const url = new URL(layout.getAttribute("data-vault-filter-url") || "", location.href);
  url.searchParams.set("q", needle);
  const sequence = filterSequence;
  filterRequest = typeof AbortController !== "undefined" ? new AbortController() : null;
  fetchMarkup(url.toString(), filterRequest ? filterRequest.signal : undefined)
    .then((markup) => {
      if (sequence !== filterSequence) return;
      moveInto(results, markup);
      results.hidden = false;
      panel.setAttribute("data-vault-filtering", "");
    })
    .catch((error) => {
      if (sequence !== filterSequence || (error && error.name === "AbortError")) return;
      results.textContent = `The filter could not run: ${failure(error)}`;
      results.hidden = false;
      panel.setAttribute("data-vault-filtering", "");
    });
}

/** Replaces the tree, listing and filter results in place; the editor and terminal are left alone. */
function refreshTree(): void {
  const layout = document.querySelector("[data-vault-layout]");
  const status = document.getElementById("vault-refresh-status");
  const url = layout ? layout.getAttribute("data-vault-refresh-url") : null;
  if (!url) return;
  refreshSequence += 1;
  const sequence = refreshSequence;
  if (status) status.hidden = true;
  fetchMarkup(url)
    .then((markup) => {
      if (sequence === refreshSequence) swapVaultSlots(markup);
    })
    .catch((error) => {
      if (sequence !== refreshSequence || !status) return;
      status.textContent = `The tree could not be refreshed: ${failure(error)}. Select Refresh tree to retry.`;
      status.hidden = false;
    });
}

function watchTreeChanges(layout: Element): void {
  const url = layout.getAttribute("data-vault-changes-url");
  if (!url || typeof EventSource === "undefined") return;
  const changes = new EventSource(url);
  changes.addEventListener("message", (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event || event.type !== "vault-tree-changed" || typeof event.generation !== "number") {
      return;
    }
    if (latestGeneration === null || event.generation > latestGeneration) {
      latestGeneration = event.generation;
    }
    showStale();
  });
}

function wirePanel(panel: Element): void {
  panel.addEventListener("click", (raw) => {
    const event = raw as MouseEvent;
    if (!isPlainClick(event)) return;
    const target = event.target as Element | null;
    const link =
      target && target.closest ? target.closest<HTMLAnchorElement>("a[data-vault-entry]") : null;
    if (!link) return;
    event.preventDefault();
    navigate(link.href, true);
  });
  panel.addEventListener(
    "toggle",
    (event) => {
      const folder = event.target as HTMLDetailsElement | null;
      if (
        folder &&
        folder.open &&
        folder.matches &&
        folder.matches("details[data-vault-children-url]")
      ) {
        loadChildren(folder);
      }
    },
    true,
  );
}

function wireTreeToggle(): void {
  const toggle = document.getElementById("vault-tree-toggle");
  if (!toggle) return;
  toggle.hidden = false;
  const hidden = document.documentElement.getAttribute("data-vault-tree") === "hidden";
  toggle.textContent = hidden ? "Show files" : "Hide files";
  toggle.setAttribute("aria-expanded", hidden ? "false" : "true");
  toggle.addEventListener("click", () => {
    showTree(document.documentElement.getAttribute("data-vault-tree") === "hidden");
  });
}

export function wireVaultBrowser(): void {
  displayedGeneration = null;
  latestGeneration = null;
  refreshSequence = 0;
  filterSequence = 0;
  filterTimer = undefined;
  filterRequest = null;
  const layout = document.querySelector("[data-vault-layout]");
  if (!layout) return;
  const panel = document.getElementById("vault-tree-panel");
  displayedGeneration = readGeneration(document.querySelector('[data-vault-slot="tree"]'));
  if (panel) wirePanel(panel);
  const refresh = document.querySelector("form[data-vault-refresh]");
  if (refresh) {
    refresh.addEventListener("submit", (event) => {
      event.preventDefault();
      refreshTree();
    });
  }
  const filter = document.getElementById("vault-filter");
  if (filter) {
    filter.hidden = false;
    filter.addEventListener("input", () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(runFilter, FILTER_DELAY);
    });
  }
  wireTreeToggle();
  watchTreeChanges(layout);
  const deferred = layout.getAttribute("data-vault-view");
  if (!deferred) return;
  fetchMarkup(deferred)
    .then(swapVaultSlots)
    .catch((error) => {
      failVaultSlots(`The files could not be listed: ${failure(error)}`);
    });
}
