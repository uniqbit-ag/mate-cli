import type { CredentialStatus } from "@uniqbit/mate-core/studio";

import {
  type CredentialTab,
  CredentialSheet,
  SETUP_TOKEN_STEPS,
} from "../../components/credential-sheet";
import { setCredentialText } from "../../lib/credential-text";
import {
  agentCredentialQuery,
  clearAgentCredential,
  setAgentCredential,
} from "../../lib/agent-credential";

const TABS: readonly CredentialTab[] = [
  {
    kind: "subscription",
    tab: "Claude subscription",
    label: "Subscription token",
    hint: SETUP_TOKEN_STEPS,
  },
  {
    kind: "api-key",
    tab: "API key",
    label: "Anthropic API key",
    hint: <p className="note">Agents bill this key. It starts with sk-ant-api.</p>,
  },
];

function statusText(status: CredentialStatus | undefined): string {
  if (!status) return "Checking…";
  return (
    setCredentialText(status) ?? "No credential set. Worksets cannot start agents until one is."
  );
}

/** The Agents panel, sliding over the page: sets the one Claude credential the factory's Workset agents use. */
export function AgentsDialog({ onClose }: { onClose: () => void }) {
  return (
    <CredentialSheet
      title="Workset agents"
      query={agentCredentialQuery()}
      set={setAgentCredential}
      clear={clearAgentCredential}
      tabs={TABS}
      statusText={statusText}
      savedText="Saved. The next agent start uses it."
      onClose={onClose}
    />
  );
}
