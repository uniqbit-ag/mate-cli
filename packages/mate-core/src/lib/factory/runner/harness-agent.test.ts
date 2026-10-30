import { describe, expect, test } from "bun:test";

import { followTurn, type TurnPart } from "./harness-agent";

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
