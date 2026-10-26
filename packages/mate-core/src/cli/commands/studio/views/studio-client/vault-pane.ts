import {
  fetchMarkup,
  guard,
  isPlainClick,
  navigate,
  setInPlaceNavigation,
  wireNavigation,
} from "./page";
import { mountViewer, status, unmountViewer, type ViewerHooks } from "./vault-editor";

/**
 * History state this module owns. `vaultScope` marks an entry whose file pane can be swapped
 * in, and names the companion it belongs to; `vaultScroll` is where the page was scrolled when
 * the entry was left.
 */
interface PaneState {
  vaultScope?: string;
  vaultScroll?: number;
}

function entry(offset: number): PaneState {
  return { vaultScope: scope(), vaultScroll: offset };
}

let swapSequence = 0;
/** The address of the state on screen, so a declined history move can put it back. */
let shownUrl = "";

function layout(): Element | null {
  return document.querySelector("[data-vault-layout]");
}

function scrollOffset(): number {
  return typeof window !== "undefined" && typeof window.scrollY === "number" ? window.scrollY : 0;
}

function scrollTo(offset: number): void {
  if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
    window.scrollTo(0, offset);
  }
}

/** The pane fragment's address for a page address on this page's own route, else `null`. */
function paneAddress(url: string): string | null {
  const route = layout()?.getAttribute("data-vault-pane-route");
  if (!route) return null;
  try {
    const target = new URL(url, location.href);
    const current = new URL(location.href);
    if (target.origin !== current.origin || target.pathname !== current.pathname) return null;
    const pane = new URL(route, location.href);
    pane.search = target.search;
    return pane.toString();
  } catch {
    return null;
  }
}

/** The companion this page's vault belongs to; a history entry of another one is not ours to swap. */
function scope(): string {
  return layout()?.getAttribute("data-vault-scope") ?? "";
}

function markShown(): void {
  const root = document.querySelector("[data-vault-root]");
  const path = root ? root.getAttribute("data-vault-path") : null;
  document.querySelectorAll("a[data-vault-entry]").forEach((link) => {
    if (path && link.getAttribute("data-vault-entry") === path) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

/** Replaces the breadcrumb and pane with the server's, rewiring what lives in them. */
function applyPane(markup: string, offset: number): void {
  const parsed = new DOMParser().parseFromString(markup, "text/html");
  const crumb = parsed.querySelector("[data-vault-crumb]");
  const pane = parsed.querySelector("[data-vault-pane]");
  const shownCrumb = document.querySelector("[data-vault-crumb]");
  const shownPane = document.querySelector("[data-vault-pane]");
  if (!crumb || !pane || !shownCrumb || !shownPane) throw new Error("no pane in the answer");
  unmountViewer();
  const nextCrumb = document.importNode(crumb, true) as Element;
  const nextPane = document.importNode(pane, true) as Element;
  shownCrumb.replaceWith(nextCrumb);
  shownPane.replaceWith(nextPane);
  wireNavigation(nextCrumb);
  wireNavigation(nextPane);
  mountViewer(hooks);
  markShown();
  scrollTo(offset);
}

type HistoryMove = "push" | "replace" | "none";

/** Shows the file `url` names in place; the latest request wins and a failed one is a normal navigation. */
function swap(url: string, move: HistoryMove, offset: number, fallback: () => void): void {
  const address = paneAddress(url);
  if (!address) {
    fallback();
    return;
  }
  swapSequence += 1;
  const mine = swapSequence;
  fetchMarkup(address)
    .then((markup) => {
      if (mine !== swapSequence) return;
      applyPane(markup, offset);
      const target = new URL(url, location.href).toString();
      if (move === "push") {
        history.replaceState({ ...(history.state as PaneState | null), vaultScroll: offset }, "");
        history.pushState(entry(offset), "", target);
      } else if (move === "replace") {
        history.replaceState(entry(offset), "", target);
      }
      shownUrl = target;
    })
    .catch(() => {
      if (mine === swapSequence) fallback();
    });
}

function showFile(url: string): boolean {
  if (!paneAddress(url)) return false;
  swap(url, "push", scrollOffset(), () => location.assign(url));
  return true;
}

const hooks: ViewerHooks = {
  saved() {
    const root = document.querySelector("[data-vault-root]");
    const read = root ? root.getAttribute("data-vault-read-href") : null;
    if (!read) return;
    const target = new URL(read, location.href).toString();
    const offset = scrollOffset();
    // The saved file is no longer the edit address, whatever navigation follows.
    history.replaceState(entry(offset), "", target);
    shownUrl = target;
    swap(target, "none", offset, () => location.assign(target));
    status("saved");
  },
  changed() {
    const target = shownUrl || location.href;
    swap(target, "none", scrollOffset(), () => {});
  },
};

function wireLinks(main: Element): void {
  main.addEventListener("click", (raw) => {
    const event = raw as MouseEvent;
    if (!isPlainClick(event)) return;
    const target = event.target as Element | null;
    const link =
      target && target.closest
        ? target.closest<HTMLAnchorElement>("a[data-vault-entry], a[data-vault-mode-link]")
        : null;
    if (!link) return;
    event.preventDefault();
    navigate(link.href, true);
  });
}

function wireHistory(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("popstate", () => {
    const next = location.href;
    const previous = shownUrl;
    const state = history.state as PaneState | null;
    const saved = state?.vaultScroll ?? 0;
    const swappable = !!state && state.vaultScope === scope();
    void guard().then((allowed) => {
      if (!allowed) {
        // Put the address of what is still shown back where the move took it from.
        history.pushState(entry(scrollOffset()), "", previous);
        return;
      }
      if (swappable) swap(next, "none", saved, () => location.reload());
      else location.reload();
    });
  });
}

/** Opens files and switches modes without replacing the document; wired once, with the page. */
export function wireVaultPane(): void {
  const shown = layout();
  if (!shown) return;
  shownUrl = location.href;
  // Only a page showing a file has a pane to come back to; a listing is reloaded.
  if (document.querySelector("[data-vault-root]")) {
    history.replaceState({ ...(history.state as PaneState | null), ...entry(scrollOffset()) }, "");
  }
  if (typeof history !== "undefined" && "scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }
  setInPlaceNavigation(showFile);
  const main = document.querySelector("[data-vault-main]");
  if (main) wireLinks(main);
  wireHistory();
  mountViewer(hooks);
}
