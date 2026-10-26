import { copy } from "./page";

const AGENT_ORDER = ["claude", "opencode"];

/** Copies whatever a control carries and confirms it in the page. */
export function wireCopyControls(): void {
  document.querySelectorAll("[data-copy]").forEach((node) => {
    node.addEventListener("click", () => {
      const text = node.getAttribute("data-copy");
      if (text) void copy(text, node.getAttribute("data-copy-label") || "prompt");
    });
  });
}

function copyPromptFor(node: Element): string | null {
  const viewed = document.documentElement.getAttribute("data-agent-viewed");
  const order = viewed ? [viewed, ...AGENT_ORDER] : AGENT_ORDER;
  for (const agent of order) {
    const text = node.getAttribute(`data-prompt-${agent}`);
    if (text) return text;
  }
  return null;
}

/** Delegated: a spec row's controls need no per-node wiring. */
export function wireDelegatedActions(): void {
  if (typeof document.addEventListener !== "function") return;
  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const run = target.closest("[data-studio-action]");
    if (run) {
      const agents = (run.getAttribute("data-studio-agents") || "").split(" ").filter(Boolean);
      document.dispatchEvent(
        new CustomEvent("studio:terminal-action", {
          detail: {
            action: run.getAttribute("data-studio-action"),
            subject: run.getAttribute("data-studio-subject"),
            agents,
          },
        }),
      );
      return;
    }
    const prompt = target.closest("[data-studio-copy-prompt]");
    if (prompt) {
      const text = copyPromptFor(prompt);
      if (text) void copy(text, "prompt");
    }
  });
}
