import {
  CHAT_CREDENTIAL_ROUTE,
  type CredentialKind,
  type CredentialStatus,
} from "@uniqbit/mate-core/studio";

import { call } from "./studio-call";
import { setCredentialText } from "./credential-text";

/**
 * The chat credential route. Only the status is cached; an entered value goes in one request
 * body and is never kept, keyed or put in an address.
 */

const chatCredentialKey = ["chat-credential"] as const;

export const chatCredentialQuery = () => ({
  queryKey: chatCredentialKey,
  queryFn: () => call<CredentialStatus>("GET", CHAT_CREDENTIAL_ROUTE),
});

export const setChatCredential = (kind: CredentialKind, value: string) =>
  call<CredentialStatus>("PUT", CHAT_CREDENTIAL_ROUTE, { kind, value });

export const clearChatCredential = () => call<CredentialStatus>("DELETE", CHAT_CREDENTIAL_ROUTE);

/** Which credential answers the chat's questions, never its value. */
export function chatCredentialText(status: CredentialStatus | undefined): string {
  if (!status) return "Checking…";
  if (status.source === "login") return "Answers use your local Claude login.";
  return (
    setCredentialText(status) ?? "No credential. Questions cannot be answered until one is set."
  );
}
