import type { FactoryClient } from "../../../lib/factory/client";
import { FactoryError } from "../../../lib/factory/ids";
import { answer, body } from "./factory-relay";

/**
 * The Git access panel's route: relays to the factory broker, which holds the Git tokens. A
 * token a person enters passes through in its one request and is never logged, kept or
 * answered; answers carry only each key's status.
 */

/** Answers a Git token route; the caller has checked factory mode, origin and token. */
export async function factoryGitTokensResponse(
  client: FactoryClient,
  request: Request,
): Promise<Response> {
  const method = request.method;
  try {
    if (method === "GET" || method === "HEAD") {
      return answer({ tokens: await client.gitToken.list() });
    }
    if (method === "PUT") {
      const { key, token } = await body(request);
      await client.gitToken.set(
        typeof key === "string" ? key : "",
        typeof token === "string" ? token : "",
      );
      return answer({ tokens: await client.gitToken.list() });
    }
    if (method === "DELETE") {
      const { key } = await body(request);
      await client.gitToken.clear(typeof key === "string" ? key : "");
      return answer({ tokens: await client.gitToken.list() });
    }
    return answer({ reason: "use GET, PUT or DELETE" }, 405);
  } catch (error) {
    if (error instanceof FactoryError) return answer({ reason: error.message }, 400);
    // Never echo an unexpected error: it could carry the token being relayed.
    return answer({ reason: "the Git token request failed" }, 500);
  }
}
