import { confirmPrompt } from "../lib/components/confirm-prompt";

export function confirm(prompt: string): Promise<boolean> {
  return confirmPrompt(prompt);
}
