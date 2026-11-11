import { FactoryError } from "../../../lib/factory/ids";

/** What the factory broker relay routes share: an uncached JSON answer and a JSON object body. */

export function answer(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FactoryError("the request needs a JSON object");
  }
  return value as Record<string, unknown>;
}
