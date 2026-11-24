import { studioFetch } from "./studio-fetch";

/** One JSON call to a Studio route; a refusal throws its `reason`. */
export async function call<T>(method: string, route: string, body?: object): Promise<T> {
  const response = await studioFetch(route, {
    method,
    headers: { accept: "application/json", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const refusal = (await response.json().catch(() => null)) as { reason?: string } | null;
    throw new Error(refusal?.reason ?? `status ${response.status}`);
  }
  return (await response.json()) as T;
}
