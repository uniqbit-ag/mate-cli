import { afterEach, describe, expect, it } from "bun:test";
import type { CredentialStatus } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, render } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ChatCredentialSheet } = await import("./chat-credential");
const { chatCredentialText } = await import("../../lib/chat-credential");

const KEY = "sk-ant-api03-acme-chat-key";
const login: CredentialStatus = { kind: null, source: "login", setAt: null };
const studioKey: CredentialStatus = {
  kind: "api-key",
  source: "studio",
  setAt: "2026-11-02T10:00:00.000Z",
};

/** Answers the chat credential route from `routes`, recording each request. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body: string | null }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(input);
    calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
    const answer = routes[`${method} ${path}`];
    return answer === undefined
      ? new Response(JSON.stringify({ reason: "not found" }), { status: 404 })
      : Response.json(answer);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

let restore: () => void = () => {};
afterEach(() => restore());
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("the chat credential sheet", () => {
  it("sets an API key in one request, empties the field and keeps nothing of it", async () => {
    const fake = fakeFetch({
      "GET /api/chat/credential": login,
      "PUT /api/chat/credential": studioKey,
    });
    restore = fake.restore;
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatCredentialSheet onClose={() => {}} />
      </QueryClientProvider>,
    );
    await settle();
    const doc = view.container.ownerDocument;
    const form = doc.querySelector<HTMLFormElement>('[data-agents-form="api-key"]')!;
    form.querySelector<HTMLInputElement>('[name="value"]')!.value = KEY;
    await act(async () => form.requestSubmit());
    await settle();
    expect(fake.calls.filter((call) => call.method === "PUT")).toEqual([
      {
        method: "PUT",
        path: "/api/chat/credential",
        body: JSON.stringify({ kind: "api-key", value: KEY }),
      },
    ]);
    expect(form.querySelector<HTMLInputElement>('[name="value"]')!.value).toBe("");
    expect(doc.querySelector("[data-agents-status]")!.textContent).toStartWith(
      "Anthropic API key, set in Studio on",
    );
    expect(doc.body.innerHTML).not.toContain(KEY);
    expect(doc.location.href).not.toContain("sk-ant");
    expect(JSON.stringify({ ...localStorage })).not.toContain("sk-ant");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("sk-ant");
    view.unmount();
  });

  it("offers the appliance an API key only", async () => {
    restore = fakeFetch({ "GET /api/chat/credential": login }).restore;
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatCredentialSheet apiKeyOnly onClose={() => {}} />
      </QueryClientProvider>,
    );
    await settle();
    const doc = view.container.ownerDocument;
    expect(doc.querySelector('[data-agents-form="api-key"]')).not.toBeNull();
    expect(doc.querySelector('[data-agents-form="subscription"]')).toBeNull();
    expect(doc.querySelector('[role="tablist"]')).toBeNull();
    expect(doc.body.textContent).not.toContain("setup-token");
    view.unmount();
  });

  it("names every source that can answer", () => {
    expect(chatCredentialText(login)).toBe("Answers use your local Claude login.");
    expect(chatCredentialText({ kind: null, source: null, setAt: null })).toStartWith(
      "No credential",
    );
    expect(chatCredentialText({ kind: "subscription", source: "startup", setAt: null })).toBe(
      "Claude subscription token, supplied at startup.",
    );
  });
});
