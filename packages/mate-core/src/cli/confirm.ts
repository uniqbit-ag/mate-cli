import { confirmPrompt } from "../lib/components/confirm-prompt";
import { releaseTerminal } from "../lib/live-progress";

export function confirm(prompt: string): Promise<boolean> {
  releaseTerminal();
  return confirmPrompt(prompt);
}
