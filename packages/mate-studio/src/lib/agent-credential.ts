import {
  type CredentialKind,
  type CredentialStatus,
  FACTORY_CREDENTIAL_ROUTE,
} from "@uniqbit/mate-core/studio";

/**
 * The Agents panel's calls to the factory credential route. Only the status is cached;
 * an entered value goes in one request body and is never kept, keyed or put in an address.
 */

export const agentCredentialKey = ["agent-credential"] as const;

export async function call<T>(method: string, route: string, body?: object): Promise<T> {
  const response = await fetch(route, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const refusal = (await response.json().catch(() => null)) as { reason?: string } | null;
    throw new Error(refusal?.reason ?? `status ${response.status}`);
  }
  return (await response.json()) as T;
}

export const agentCredentialQuery = () => ({
  queryKey: agentCredentialKey,
  queryFn: () => call<CredentialStatus>("GET", FACTORY_CREDENTIAL_ROUTE),
});

export const setAgentCredential = (kind: CredentialKind, value: string) =>
  call<CredentialStatus>("PUT", FACTORY_CREDENTIAL_ROUTE, { kind, value });

export const clearAgentCredential = () =>
  call<CredentialStatus>("DELETE", FACTORY_CREDENTIAL_ROUTE);
