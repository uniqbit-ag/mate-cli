import type { CredentialKind, CredentialStatus } from "@uniqbit/mate-core/studio";

const KIND_LABELS: Record<CredentialKind, string> = {
  subscription: "Claude subscription token",
  "api-key": "Anthropic API key",
};

/** "Anthropic API key, set in Studio on …" for a set credential; null when none is set or supplied. */
export function setCredentialText(status: CredentialStatus): string | null {
  if (!status.kind) return null;
  const source =
    status.source === "studio"
      ? `set in Studio${status.setAt ? ` on ${new Date(status.setAt).toLocaleString()}` : ""}`
      : "supplied at startup";
  return `${KIND_LABELS[status.kind]}, ${source}.`;
}
