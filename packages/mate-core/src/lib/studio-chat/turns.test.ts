import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";

import { ChatTurns } from "./turns";

/** A stream that stays open until its signal aborts, as an agent turn does. */
function agentStream(
  signal: AbortSignal,
  chunks: UIMessageChunk[] = [],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      signal.addEventListener("abort", () => controller.close(), { once: true });
    },
  });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) chunks.push(chunk);
  return chunks;
}

describe("ChatTurns", () => {
  test("runs at most two turns; a finished turn frees its place", async () => {
    const turns = new ChatTurns();
    const first = turns.begin()!;
    const second = turns.begin()!;
    expect(turns.full).toBe(true);
    expect(turns.begin()).toBeNull();
    const done = drain(first.track(new ReadableStream({ start: (c) => c.close() })));
    await done;
    expect(turns.size).toBe(1);
    expect(turns.full).toBe(false);
    expect(turns.begin()).not.toBeNull();
    void second;
  });

  test("an abandoned turn is aborted and frees its place", () => {
    const turns = new ChatTurns({ max: 1 });
    const turn = turns.begin()!;
    expect(turns.full).toBe(true);
    turn.abandon();
    expect(turn.signal.aborted).toBe(true);
    expect(turns.size).toBe(0);
    expect(turns.begin()).not.toBeNull();
  });

  test("a timed-out turn is aborted and says why", async () => {
    const turns = new ChatTurns({ timeoutMs: 20 });
    const turn = turns.begin()!;
    const chunks = await drain(turn.track(agentStream(turn.signal, [{ type: "start" }])));
    expect(turn.signal.aborted).toBe(true);
    expect(chunks).toEqual([
      { type: "start" },
      { type: "error", errorText: expect.stringContaining("took longer than") },
    ]);
    expect(turns.size).toBe(0);
  });

  test("the request's abort ends the turn", async () => {
    const turns = new ChatTurns();
    const request = new AbortController();
    const turn = turns.begin(request.signal)!;
    const done = drain(turn.track(agentStream(turn.signal)));
    request.abort();
    expect(await done).toEqual([]);
    expect(turns.size).toBe(0);
  });

  test("a cancelled response aborts the turn", async () => {
    const turns = new ChatTurns();
    const turn = turns.begin()!;
    await turn.track(agentStream(turn.signal)).cancel("client left");
    expect(turn.signal.aborted).toBe(true);
    expect(turns.size).toBe(0);
  });

  test("an agent stream that errors frees its place", async () => {
    const turns = new ChatTurns();
    const turn = turns.begin()!;
    const failing = new ReadableStream<UIMessageChunk>({ pull: (c) => c.error(new Error("boom")) });
    await expect(drain(turn.track(failing))).rejects.toThrow("boom");
    expect(turns.size).toBe(0);
  });

  test("a timed-out turn nobody reads stops its agent and frees its place", async () => {
    const turns = new ChatTurns({ timeoutMs: 20 });
    const turn = turns.begin()!;
    let cancelled = false;
    turn.track(new ReadableStream<UIMessageChunk>({ cancel: () => void (cancelled = true) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toBe(true);
    expect(turns.size).toBe(0);
  });

  test("a cancelled turn keeps its place until the agent has cleaned up", async () => {
    const turns = new ChatTurns();
    const turn = turns.begin()!;
    let cleaned!: () => void;
    const cleanup = new Promise<void>((resolve) => (cleaned = resolve));
    const cancelling = turn
      .track(new ReadableStream<UIMessageChunk>({ cancel: () => cleanup }))
      .cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turns.size).toBe(1);
    cleaned();
    await cancelling;
    expect(turns.size).toBe(0);
  });

  test("stopping aborts every turn, waits for them, and starts no new one", async () => {
    const turns = new ChatTurns();
    const a = turns.begin()!;
    const b = turns.begin()!;
    const reading = [drain(a.track(agentStream(a.signal))), drain(b.track(agentStream(b.signal)))];
    await turns.stopAll();
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(turns.size).toBe(0);
    expect(turns.begin()).toBeNull();
    await Promise.all(reading);
  });
});
