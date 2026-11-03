import { useEffect } from "react";

import { copyText } from "../stores/page-ui";
import { useTerminalUi } from "../stores/terminal-ui";

const AGENT_ORDER = ["claude", "opencode"];

/** The prompt for the agent the terminal shows, else the first agent that has one. */
function promptFor(node: Element): string | null {
  const viewed = useTerminalUi.getState().viewing;
  const order = viewed && viewed !== "pending" ? [viewed, ...AGENT_ORDER] : AGENT_ORDER;
  for (const agent of order) {
    const text = node.getAttribute(`data-prompt-${agent}`);
    if (text) return text;
  }
  return null;
}

/**
 * One delegated handler for the views' copy and run controls, so a long list needs no
 * handler per row: `data-copy` copies its text, `data-studio-copy-prompt` the prompt for the
 * viewed agent, and `data-studio-action` runs a registered skill action in the terminal.
 */
export function useStudioClicks(): void {
  useEffect(() => {
    const click = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest) return;
      const run = target.closest("[data-studio-action]");
      if (run) {
        useTerminalUi.getState().controller?.runAction({
          action: run.getAttribute("data-studio-action") ?? "",
          subject: run.getAttribute("data-studio-subject") ?? "",
          agents: (run.getAttribute("data-studio-agents") ?? "").split(" ").filter(Boolean),
        });
        return;
      }
      const copy = target.closest("[data-copy]");
      if (copy) {
        const text = copy.getAttribute("data-copy");
        if (text) copyText(text, copy.getAttribute("data-copy-label") || "prompt");
        return;
      }
      const prompt = target.closest("[data-studio-copy-prompt]");
      if (prompt) {
        const text = promptFor(prompt);
        if (text) copyText(text, "prompt");
      }
    };
    document.addEventListener("click", click);
    return () => document.removeEventListener("click", click);
  }, []);
}
