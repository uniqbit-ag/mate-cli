import { connectionStateOf } from "@uniqbit/mate-core/studio";

/**
 * A background read of Studio's that throws on a connection problem, so the query cache sees
 * the failure and the page probes. Any answer of Studio's, a refusal included, is returned.
 */
export async function studioFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, credentials: "same-origin", redirect: "manual" });
  const problem = connectionStateOf(response);
  if (problem) throw new Error(`Studio connection: ${problem}`);
  return response;
}
