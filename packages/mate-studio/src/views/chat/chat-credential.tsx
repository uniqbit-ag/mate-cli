import {
  type CredentialTab,
  CredentialSheet,
  SETUP_TOKEN_STEPS,
} from "../../components/credential-sheet";
import { useChatUi } from "../../stores/chat-ui";
import {
  chatCredentialQuery,
  chatCredentialText,
  clearChatCredential,
  setChatCredential,
} from "../../lib/chat-credential";

/** API key first: it is the unambiguous choice for a third-party agent. */
const TABS: readonly CredentialTab[] = [
  {
    kind: "api-key",
    tab: "API key",
    label: "Anthropic API key",
    hint: <p className="note">Answers bill this key. It starts with sk-ant-api.</p>,
  },
  {
    kind: "subscription",
    tab: "Claude subscription",
    label: "Subscription token",
    hint: SETUP_TOKEN_STEPS,
  },
];

/** The appliance takes an API key only. */
export function ChatCredentialSheet({
  apiKeyOnly = false,
  onClose,
}: {
  apiKeyOnly?: boolean;
  onClose: () => void;
}) {
  return (
    <CredentialSheet
      title="Chat credential"
      query={chatCredentialQuery()}
      set={setChatCredential}
      clear={clearChatCredential}
      tabs={apiKeyOnly ? TABS.slice(0, 1) : TABS}
      statusText={chatCredentialText}
      savedText="Saved. The next question uses it."
      onClose={onClose}
    />
  );
}

/** The one chat credential sheet, opened from the session panel's header or a failed answer. */
export function ChatCredentialHost({ apiKeyOnly = false }: { apiKeyOnly?: boolean }) {
  const open = useChatUi((state) => state.credentialOpen);
  const setOpen = useChatUi((state) => state.setCredentialOpen);
  return open ? (
    <ChatCredentialSheet apiKeyOnly={apiKeyOnly} onClose={() => setOpen(false)} />
  ) : null;
}
