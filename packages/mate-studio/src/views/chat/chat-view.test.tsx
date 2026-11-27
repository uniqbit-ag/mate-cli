import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatSession, CredentialStatus } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, fireEvent, render } = await import("@testing-library/react");
const { ChatView: View } = await import("./chat-view");
const { inRouter } = await import("../../../test/render");
const { chatSessionQuery } = await import("../../lib/chat-session");
const { chatCredentialQuery } = await import("../../lib/chat-credential");
const { ChatCredentialHost } = await import("./chat-credential");
const { useChatUi } = await import("../../stores/chat-ui");
const { failureText, questionAnchor, stepSummary, toolTarget } = await import("./chat-text");

const SESSION: ChatSession = { mcpServers: [], plugins: [] };
const LOGIN: CredentialStatus = { kind: null, source: "login", setAt: null };

/** The view with the session and credential routes' answers already held, so the panel reads no network. */
function ChatView(props: Parameters<typeof View>[0]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(chatSessionQuery(props.companion).queryKey, SESSION);
  client.setQueryData(chatCredentialQuery().queryKey, LOGIN);
  // The layout hosts the credential sheet beside every view.
  return (
    <QueryClientProvider client={client}>
      {inRouter(<View {...props} />)}
      <ChatCredentialHost />
    </QueryClientProvider>
  );
}

type Fetch = typeof globalThis.fetch;

interface Call {
  url: string;
  body: {
    companion: string;
    messages: { role: string; parts: { type: string; text?: string }[] }[];
  };
  signal: AbortSignal | null | undefined;
}

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "x-vercel-ai-ui-message-stream": "v1",
};

function sse(
  chunks: unknown[],
  { hold = false, signal }: { hold?: boolean; signal?: AbortSignal | null } = {},
) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        if (!hold) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          {
            once: true,
          },
        );
      },
    }),
    { headers: SSE_HEADERS },
  );
}

/** A fake chat route: records each call and answers with `respond`. */
function fakeFetch(respond: (call: Call) => Response): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  }) as Fetch;
  return { fetch, calls };
}

const ANSWER = [
  { type: "start" },
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "t1",
    toolName: "read",
    input: { file_path: "openspec/specs/acme-queue/spec.md" },
  },
  { type: "tool-output-available", toolCallId: "t1", output: "# acme-queue" },
  { type: "finish-step" },
  { type: "start-step" },
  { type: "text-start", id: "a" },
  { type: "text-delta", id: "a", delta: "Two capabilities: **acme-queue**" },
  { type: "text-delta", id: "a", delta: " and **acme-retry**." },
  { type: "text-end", id: "a" },
  { type: "finish-step" },
  { type: "finish" },
];

const settle = () => act(async () => new Promise((done) => setTimeout(done, 30)));

async function ask(container: HTMLElement, text: string) {
  const field = container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!;
  await act(async () => fireEvent.change(field, { target: { value: text } }));
  await act(async () => field.form!.requestSubmit());
  await settle();
}

describe("ChatView", () => {
  it("hints at what can be asked while the conversation is empty", () => {
    const { fetch } = fakeFetch(() => sse([]));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    const empty = page.container.querySelector("#chat-empty")!;
    expect(empty.textContent).toContain("Try asking");
    expect(empty.querySelectorAll("button").length).toBeGreaterThan(0);
    page.unmount();
  });

  it("sends the question with the companion and streams the answer with its tool step", async () => {
    const { fetch, calls } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/chat");
    expect(calls[0]!.body.companion).toBe("0123456789");
    expect(calls[0]!.body.messages.at(-1)).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "Which capabilities exist?" }],
    });
    const user = page.container.querySelector('[data-chat-message="user"]')!;
    expect(user.textContent).toBe("Which capabilities exist?");
    const assistant = page.container.querySelector('[data-chat-message="assistant"]')!;
    expect(assistant.querySelector("strong")?.textContent).toBe("acme-queue");
    expect(assistant.textContent).toContain("acme-retry");
    const step = assistant.querySelector('[data-chat-tool="read"]')!;
    expect(step.textContent).toContain("openspec/specs/acme-queue/spec.md");
    expect(page.container.querySelector("#chat-empty")).toBeNull();
    page.unmount();
  });

  it("stops a streaming answer and keeps what arrived", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      sse(
        [
          { type: "start" },
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "Partial answer" },
        ],
        { hold: true, signal: call.signal },
      ),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Summarize the open changes.");
    const stop = page.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop the answer"]',
    )!;
    expect(stop).not.toBeNull();
    await act(async () => stop.click());
    await settle();

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(page.container.querySelector('[data-chat-message="assistant"]')?.textContent).toContain(
      "Partial answer",
    );
    expect(page.container.querySelector('button[aria-label="Send"]')).not.toBeNull();
    page.unmount();
  });

  it("queues a question asked while an answer comes, and sends it once that answer ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const encoder = new TextEncoder();
    const { fetch, calls } = fakeFetch(() => {
      if (calls.length > 1) return sse(ANSWER);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (chunk: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            write({ type: "start" });
            write({ type: "text-start", id: "a" });
            write({ type: "text-delta", id: "a", delta: "First answer" });
            await gate;
            write({ type: "text-end", id: "a" });
            write({ type: "finish" });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: SSE_HEADERS },
      );
    });
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And the second one?");

    expect(calls).toHaveLength(1);
    expect(
      page.container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!.value,
    ).toBe("");
    expect(page.container.querySelector("[data-chat-queue]")?.textContent).toContain(
      "And the second one?",
    );
    await act(async () => release());
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages.at(-1)).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "And the second one?" }],
    });
    expect(page.container.querySelector("[data-chat-queue]")).toBeNull();
    page.unmount();
  });

  it("holds the queue when the answer is stopped", async () => {
    const { fetch, calls } = fakeFetch((call) =>
      sse([{ type: "start" }], { hold: true, signal: call.signal }),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And the second one?");
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>('button[aria-label="Stop the answer"]')!
        .click(),
    );
    await settle();
    expect(calls).toHaveLength(1);
    expect(page.container.querySelector("[data-chat-queue]")?.textContent).toContain(
      "And the second one?",
    );
    // Rewinding drops the held follow-ups with the conversation they belonged to.
    await act(async () =>
      page.container.querySelector<HTMLButtonElement>("[data-chat-checkpoint]")!.click(),
    );
    expect(page.container.querySelector("[data-chat-queue]")).toBeNull();
    page.unmount();
  });

  it("sends the chosen model and effort, and no effort for a model that takes none", async () => {
    const { useChatUi } = await import("../../stores/chat-ui");
    const { fetch, calls } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    expect(page.container.querySelector('[aria-label="Model"]')?.textContent).toContain("Sonnet");
    await act(async () => useChatUi.getState().setEffort("high"));
    await ask(page.container, "Which capabilities exist?");
    expect(calls[0]!.body).toMatchObject({ model: "sonnet", effort: "high" });

    await act(async () => useChatUi.getState().setModel("haiku"));
    expect(page.container.querySelector<HTMLButtonElement>('[aria-label="Effort"]')!.disabled).toBe(
      true,
    );
    await ask(page.container, "And the second one?");
    expect(calls[1]!.body).toMatchObject({ model: "haiku" });
    expect(calls[1]!.body).not.toHaveProperty("effort");
    await act(async () => useChatUi.setState({ model: "sonnet", effort: "medium" }));
    page.unmount();
  });

  it("shows the answer's reasoning, the files it read, and cites those it names", async () => {
    const root = "/home/dev/.mate/companions/acme";
    const { fetch } = fakeFetch(() =>
      sse([
        { type: "start" },
        { type: "start-step" },
        { type: "reasoning-start", id: "r" },
        { type: "reasoning-delta", id: "r", delta: "The queue spec should say." },
        { type: "reasoning-end", id: "r" },
        {
          type: "tool-input-available",
          toolCallId: "t1",
          toolName: "read",
          input: { file_path: `${root}/openspec/specs/acme-queue/spec.md` },
        },
        { type: "tool-output-available", toolCallId: "t1", output: "# acme-queue" },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "a" },
        {
          type: "text-delta",
          id: "a",
          delta: "See `openspec/specs/acme-queue/spec.md`, not `openspec/specs/other.md`.",
        },
        { type: "text-end", id: "a" },
        { type: "finish-step" },
        { type: "finish" },
      ]),
    );
    const page = render(<ChatView companion="0123456789" roots={[root]} transport={{ fetch }} />);
    await ask(page.container, "What does the queue do?");
    const answer = page.container.querySelector('[data-chat-message="assistant"]')!;

    expect(answer.querySelector("[data-chat-reasoning]")?.textContent).toContain("Reasoning");
    expect(answer.querySelector("[data-chat-sources]")?.textContent).toContain("Read 1 file");
    const cited = [...answer.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    expect(cited).toEqual([
      "/vault?companion=0123456789&studioMode=analysis&path=openspec%2Fspecs%2Facme-queue%2Fspec.md",
    ]);
    expect(answer.textContent).toContain("openspec/specs/other.md");
    page.unmount();
  });

  it("rewinds to an earlier question and puts it back in the field", async () => {
    const { fetch } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And what does acme-retry do?");
    expect(page.container.querySelectorAll('[data-chat-message="user"]')).toHaveLength(2);
    expect(page.container.querySelectorAll("[data-chat-question]")).toHaveLength(2);
    expect(page.container.querySelector("[data-chat-context]")).not.toBeNull();

    const checkpoints =
      page.container.querySelectorAll<HTMLButtonElement>("[data-chat-checkpoint]");
    await act(async () => checkpoints[1]!.click());
    await settle();
    expect(page.container.querySelectorAll('[data-chat-message="user"]')).toHaveLength(1);
    expect(page.container.querySelectorAll("[data-chat-question]")).toHaveLength(1);
    expect(
      page.container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!.value,
    ).toBe("And what does acme-retry do?");
    page.unmount();
  });

  it("names only the MCP servers and plugins a turn loads in the session panel", () => {
    const { fetch } = fakeFetch(() => sse([]));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    const panel = page.container.querySelector("[data-chat-session]")!;
    const groups = [...panel.querySelectorAll("[data-chat-session-group]")].map((group) =>
      group.getAttribute("data-chat-session-group"),
    );
    expect(groups).toEqual(["MCP servers", "Plugins"]);
    for (const group of panel.querySelectorAll("[data-chat-session-group]")) {
      expect(group.textContent).toContain("None loaded");
    }
    expect(page.container.querySelector("[data-chat-questions]")).toBeNull();
    page.unmount();
  });

  it("remembers a collapsed panel across a remount", async () => {
    const { fetch } = fakeFetch(() => sse([]));
    const first = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await act(async () =>
      first.container.querySelector<HTMLButtonElement>("[data-chat-panel-toggle]")!.click(),
    );
    expect(
      first.container.querySelector("[data-chat-panel]")!.getAttribute("data-chat-panel"),
    ).toBe("closed");
    first.unmount();
    expect(JSON.parse(localStorage.getItem("mate.chat.model")!).state.panelOpen).toBe(false);

    const second = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    expect(second.container.querySelector("[data-chat-session]")).toBeNull();
    expect(
      second.container.querySelector("[data-chat-panel]")!.getAttribute("data-chat-panel"),
    ).toBe("closed");
    second.unmount();
    useChatUi.getState().setPanelOpen(true);
  });

  it("scrolls to a question from its panel entry", async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const { fetch } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And what does acme-retry do?");
    await ask(page.container, "And acme-queue?");
    const entries = page.container.querySelectorAll<HTMLButtonElement>("[data-chat-question]");
    expect([...entries].map((entry) => entry.textContent)).toEqual([
      "Which capabilities exist?",
      "And what does acme-retry do?",
      "And acme-queue?",
    ]);
    expect(
      page.container.querySelectorAll('[data-chat-question][aria-current="true"]'),
    ).toHaveLength(1);
    const first = page.container.querySelector('[data-chat-message="user"]')!;
    await act(async () => entries[0]!.click());
    expect(scrolled).toEqual([first.id]);
    expect(first.id).toStartWith(questionAnchor(""));
    Element.prototype.scrollIntoView = original;
    page.unmount();
  });

  it("restores a question from its panel entry", async () => {
    const { fetch } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And what does acme-retry do?");
    await ask(page.container, "And acme-queue?");
    const restores = page.container.querySelectorAll<HTMLButtonElement>(
      "[data-chat-question-restore]",
    );
    await act(async () => restores[1]!.click());
    await settle();
    const left = [...page.container.querySelectorAll("[data-chat-message]")].map((message) =>
      message.getAttribute("data-chat-message"),
    );
    expect(left).toEqual(["user", "assistant"]);
    expect(page.container.querySelector('[data-chat-message="user"]')!.textContent).toContain(
      "Which capabilities exist?",
    );
    expect(
      page.container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')!.value,
    ).toBe("And what does acme-retry do?");
    page.unmount();
  });

  it("marks a step still running when the answer stops as stopped", async () => {
    const { fetch } = fakeFetch((call) =>
      sse(
        [
          { type: "start" },
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "t1",
            toolName: "read",
            input: { file_path: "openspec/specs/acme-queue/spec.md" },
          },
        ],
        { hold: true, signal: call.signal },
      ),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    const step = () => page.container.querySelector('[data-chat-tool="read"]')!;
    expect(step().textContent).toContain("running");
    await act(async () =>
      page.container
        .querySelector<HTMLButtonElement>('button[aria-label="Stop the answer"]')!
        .click(),
    );
    await settle();
    expect(step().textContent).toContain("stopped");
    expect(step().textContent).not.toContain("running");
    page.unmount();
  });

  it("shows a link in an answer as text, not as something to click", async () => {
    const { fetch } = fakeFetch(() =>
      sse([
        { type: "start" },
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "See [the docs](https://acme.example/?q=1)." },
        { type: "text-end", id: "a" },
        { type: "finish" },
      ]),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Where are the docs?");
    const assistant = page.container.querySelector('[data-chat-message="assistant"]')!;
    expect(assistant.querySelector("a")).toBeNull();
    expect(assistant.textContent).toContain("the docs (https://acme.example/?q=1)");
    page.unmount();
  });

  it("shows a failed turn inline and keeps the conversation", async () => {
    let turn = 0;
    const { fetch } = fakeFetch(() => {
      turn += 1;
      if (turn === 1) return sse(ANSWER);
      return sse([
        { type: "start" },
        {
          type: "error",
          errorText:
            "Claude Code has no local login on this machine. Run `claude` in a terminal, log in, then ask again.",
        },
      ]);
    });
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    await ask(page.container, "And what does acme-retry do?");

    expect(page.container.querySelector("#chat-error")?.textContent).toContain("no local login");
    expect(page.container.querySelectorAll('[data-chat-message="user"]')).toHaveLength(2);
    expect(page.container.querySelector('[data-chat-message="assistant"]')?.textContent).toContain(
      "acme-retry",
    );
    page.unmount();
  });

  it("offers the credential sheet for a turn that failed for want of a credential", async () => {
    const { fetch } = fakeFetch(() =>
      sse([
        { type: "start" },
        {
          type: "error",
          errorText:
            "Studio Chat has no Claude credential. Set one under Credential in the session panel, or supply ANTHROPIC_API_KEY through credentials:.",
        },
      ]),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    const open = page.container.querySelector<HTMLButtonElement>("[data-chat-error-credential]")!;
    expect(open.textContent).toContain("Open credential");
    await act(async () => open.click());
    await settle();
    const doc = page.container.ownerDocument;
    expect(doc.querySelector("#agents-title")?.textContent).toBe("Chat credential");
    // The API key tab opens first.
    expect(doc.querySelector('[data-agents-form="api-key"]')).not.toBeNull();
    expect(doc.querySelector("[data-agents-status]")?.textContent).toBe(
      "Answers use your local Claude login.",
    );
    page.unmount();
    useChatUi.setState({ credentialOpen: false });
  });

  it("opens the credential sheet from the session panel's header", async () => {
    const { fetch } = fakeFetch(() => sse([]));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    const open = page.container.querySelector<HTMLButtonElement>(
      "[data-chat-panel] [data-open-chat-credential]",
    )!;
    expect(open.textContent).toBe("Credential");
    await act(async () => open.click());
    await settle();
    expect(page.container.ownerDocument.querySelector("#agents-title")?.textContent).toBe(
      "Chat credential",
    );
    page.unmount();
    useChatUi.setState({ credentialOpen: false });
  });

  it("offers no credential sheet for another failure", async () => {
    const { fetch } = fakeFetch(() =>
      sse([
        { type: "start" },
        { type: "error", errorText: "Claude Code: the bridge did not start" },
      ]),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    expect(page.container.querySelector("#chat-error")).not.toBeNull();
    expect(page.container.querySelector("[data-chat-error-credential]")).toBeNull();
    page.unmount();
  });

  it("shows the server's refusal reason", async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            reason: "the chat is offered only when Studio listens on localhost alone",
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Hello?");
    expect(page.container.querySelector("#chat-error")?.textContent).toContain(
      "only when Studio listens on localhost alone",
    );
    page.unmount();
  });

  /** An answer that runs `tools` in order, one step each, then says it is done. */
  function stepsThenText(tools: string[]) {
    const steps = tools.flatMap((toolName, index) => [
      {
        type: "tool-input-available",
        toolCallId: `t${index}`,
        toolName,
        input: { file_path: `openspec/specs/acme-${index}/spec.md` },
      },
      { type: "tool-output-available", toolCallId: `t${index}`, output: "# acme" },
    ]);
    return sse([
      { type: "start" },
      { type: "start-step" },
      ...steps,
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Done." },
      { type: "text-end", id: "a" },
      { type: "finish-step" },
      { type: "finish" },
    ]);
  }

  it("batches consecutive reads into one row that opens to each step", async () => {
    const { fetch } = fakeFetch(() => stepsThenText(Array(5).fill("read")));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");

    const batch = page.container.querySelector('[data-chat-batch="read"]')!;
    expect(batch.textContent).toContain("Read 5 files");
    expect(batch.textContent).toContain("spec.md, spec.md");
    // One row needs no further folding.
    expect(page.container.querySelector("[data-chat-steps]")).toBeNull();
    expect(page.container.querySelector("[data-chat-tool]")).toBeNull();
    await act(async () => batch.querySelector("button")!.click());
    await settle();
    expect(page.container.querySelectorAll("[data-chat-tool]")).toHaveLength(5);
    page.unmount();
  });

  it("folds a long run of rows into one line once the answer moves on", async () => {
    const { fetch } = fakeFetch(() => stepsThenText(["read", "grep", "read", "glob", "read"]));
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");

    const steps = page.container.querySelector("[data-chat-steps]")!;
    expect(steps.textContent).toContain("5 steps · read 3, grep 1, glob 1");
    expect(page.container.querySelector("[data-chat-tool]")).toBeNull();
    await act(async () => steps.querySelector("button")!.click());
    await settle();
    expect(page.container.querySelectorAll("[data-chat-tool]")).toHaveLength(5);
    expect(page.container.querySelector("[data-chat-batch]")).toBeNull();
    page.unmount();
  });

  it("tries a failed answer again, and starts over on request", async () => {
    let turn = 0;
    const { fetch, calls } = fakeFetch(() => {
      turn += 1;
      if (turn === 1)
        return sse([{ type: "start" }, { type: "error", errorText: "the bridge did not start" }]);
      return sse(ANSWER);
    });
    const page = render(<ChatView companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    expect(page.container.querySelector("#chat-error")).not.toBeNull();

    const retry = [...page.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.messages.at(-1)).toMatchObject({ role: "user" });
    expect(page.container.querySelector("#chat-error")).toBeNull();
    expect(page.container.querySelector('[data-chat-message="assistant"]')?.textContent).toContain(
      "acme-retry",
    );

    const startOver = [...page.container.querySelectorAll("button")].find(
      (button) => button.textContent === "New conversation",
    )!;
    await act(async () => startOver.click());
    await settle();
    expect(page.container.querySelector("[data-chat-message]")).toBeNull();
    expect(page.container.querySelector("#chat-empty")).not.toBeNull();
    page.unmount();
  });

  it("starts an empty conversation for another companion", async () => {
    const { fetch, calls } = fakeFetch(() => sse(ANSWER));
    const page = render(<ChatView key="0123456789" companion="0123456789" transport={{ fetch }} />);
    await ask(page.container, "Which capabilities exist?");
    expect(page.container.querySelector('[data-chat-message="assistant"]')).not.toBeNull();

    page.rerender(<ChatView key="abcdef0123" companion="abcdef0123" transport={{ fetch }} />);
    await settle();
    expect(page.container.querySelector("[data-chat-message]")).toBeNull();
    expect(page.container.querySelector("#chat-empty")).not.toBeNull();
    await ask(page.container, "Which capabilities exist?");
    expect(calls.at(-1)!.body.companion).toBe("abcdef0123");
    expect(calls.at(-1)!.body.messages).toHaveLength(1);
    page.unmount();
  });
});

describe("toolTarget and failureText", () => {
  it("names a tool's target in one short line", () => {
    expect(toolTarget({ pattern: "openspec/**/spec.md", path: "." })).toBe("openspec/**/spec.md");
    expect(toolTarget({ file_path: `a/${"b".repeat(100)}` })).toHaveLength(80);
    expect(toolTarget(null)).toBe("");
  });

  it("sums up a run of steps by tool, naming failures", () => {
    expect(
      stepSummary([
        { name: "glob", failed: false },
        { name: "read", failed: false },
        { name: "read", failed: true },
      ]),
    ).toBe("3 steps · glob 1, read 2 · 1 failed");
  });

  it("reads a refusal's reason, or the message as it is", () => {
    expect(failureText(new Error('{"reason":"no registered companion was selected"}'))).toBe(
      "no registered companion was selected",
    );
    expect(failureText(new Error("the bridge did not start"))).toBe("the bridge did not start");
  });
});
