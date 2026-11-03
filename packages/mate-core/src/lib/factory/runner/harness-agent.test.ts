import { describe, expect, test } from "bun:test";

import { followTurn, toolSummary, type TurnPart } from "./harness-agent";

async function* parts(...list: TurnPart[]): AsyncIterable<TurnPart> {
  for (const part of list) yield part;
}

describe("following an agent turn", () => {
  test("logs text and reports a finished turn", async () => {
    const texts: string[] = [];
    const failure = await followTurn(
      parts(
        { type: "text-delta", text: "Proposing " },
        { type: "tool-call" },
        { type: "text-delta", text: "acme-greet" },
        { type: "finish", finishReason: "stop" },
      ),
      (text) => texts.push(text),
    );
    expect(failure).toBeNull();
    expect(texts.join("")).toBe("Proposing acme-greet");
  });

  test("text blocks streaming side by side are logged whole, in the order they end", async () => {
    const texts: string[] = [];
    await followTurn(
      parts(
        { type: "text-delta", id: "a", text: "Reading the " },
        { type: "text-delta", id: "b", text: "Schema: " },
        { type: "text-delta", id: "a", text: "workset." },
        { type: "text-delta", id: "b", text: "mate-v1." },
        { type: "text-end", id: "b" },
        { type: "text-end", id: "a" },
        { type: "text-delta", id: "c", text: "Unfinished" },
      ),
      (text) => texts.push(text),
    );
    expect(texts).toEqual(["Schema: mate-v1.\n", "Reading the workset.\n", "Unfinished\n"]);
  });

  test("an error part fails the turn with its message", async () => {
    const failure = await followTurn(
      parts(
        { type: "error", error: new Error("401 OAuth access token is invalid.") },
        { type: "finish", finishReason: "error" },
      ),
      () => {},
    );
    expect(failure).toBe("401 OAuth access token is invalid.");
  });

  test("an error finish without an error part still fails", async () => {
    expect(await followTurn(parts({ type: "finish", finishReason: "error" }), () => {})).toBe(
      "the agent ended with an error",
    );
  });
});

describe("live turn events", () => {
  test("text streams as it arrives and is logged as streamed; tools show a short summary", async () => {
    const logged: [string, boolean | undefined][] = [];
    const events: unknown[] = [];
    await followTurn(
      parts(
        { type: "text-delta", id: "a", text: "Reading " },
        { type: "tool-call", toolName: "Bash", input: { command: "git   status\n--short" } },
        { type: "tool-result", toolName: "Bash" },
        { type: "tool-error", toolName: "Read" },
        { type: "text-delta", id: "a", text: "done." },
        { type: "text-end", id: "a" },
      ),
      (text, streamed) => logged.push([text, streamed]),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: "text", id: "a", delta: "Reading " },
      { type: "tool", name: "Bash", summary: "git status --short" },
      { type: "tool-done", name: "Bash", failed: false },
      { type: "tool-done", name: "Read", failed: true },
      { type: "text", id: "a", delta: "done." },
      { type: "text-end", id: "a" },
    ]);
    expect(logged).toEqual([["Reading done.\n", true]]);
  });

  test("tool summaries stay one short line", () => {
    expect(toolSummary({ file_path: "a".repeat(200) })).toHaveLength(80);
    expect(toolSummary({ count: 3 })).toBe("");
    expect(toolSummary(null)).toBe("");
  });
});
