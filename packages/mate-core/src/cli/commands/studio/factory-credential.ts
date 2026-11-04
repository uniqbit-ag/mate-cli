import type { FactoryClient } from "../../../lib/factory/client";
import type { CredentialKind } from "../../../lib/factory/credential-store";
import { FactoryError } from "../../../lib/factory/ids";

/**
 * The Agents panel's route: relays to the factory broker, which holds the Workset
 * agent credential. A value a person enters passes through in its one request and is
 * never logged, kept or answered; answers carry only the status.
 */

function answer(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FactoryError("the request needs a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Answers a credential route; the caller has checked factory mode, origin and token. */
export async function factoryCredentialResponse(
  client: FactoryClient,
  request: Request,
): Promise<Response> {
  const method = request.method;
  try {
    if (method === "GET" || method === "HEAD") return answer(await client.credential.status());
    if (method === "PUT") {
      const { kind, value } = await body(request);
      await client.credential.set(kind as CredentialKind, typeof value === "string" ? value : "");
      return answer(await client.credential.status());
    }
    if (method === "DELETE") {
      await client.credential.clear();
      return answer(await client.credential.status());
    }
    return answer({ reason: "use GET, PUT or DELETE" }, 405);
  } catch (error) {
    if (error instanceof FactoryError) return answer({ reason: error.message }, 400);
    // Never echo an unexpected error: it could carry the value being relayed.
    return answer({ reason: "the credential request failed" }, 500);
  }
}
