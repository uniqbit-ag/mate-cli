import type { UIMessageChunk } from "ai";

import { within } from "../../runtime/host-process";

/**
 * The chat turns Studio is running: at most `max` at once, each ended after `timeoutMs`,
 * and all of them when Studio stops, so no chat agent outlives the server. A turn holds
 * no conversation; it is only its abort.
 */

const CHAT_TURN_LIMITS = { concurrent: 2, timeoutMs: 10 * 60_000 } as const;

export interface ChatTurn {
  readonly signal: AbortSignal;
  /** Wraps the agent's stream: the turn ends when it does, and a timeout is reported in it. */
  track(stream: ReadableStream<UIMessageChunk>): ReadableStream<UIMessageChunk>;
  /** Ends a turn whose agent never produced a stream, freeing its place. */
  abandon(): void;
}

class TurnTimeout extends Error {}

/** How long stopping waits for running turns to end their processes. */
const STOP_WAIT_MS = 5_000;

export class ChatTurns {
  /** Each running turn's abort, and when it has ended. */
  readonly #running = new Map<AbortController, Promise<void>>();
  readonly #max: number;
  readonly #timeoutMs: number;
  #stopped = false;

  constructor(options: { max?: number; timeoutMs?: number } = {}) {
    this.#max = options.max ?? CHAT_TURN_LIMITS.concurrent;
    this.#timeoutMs = options.timeoutMs ?? CHAT_TURN_LIMITS.timeoutMs;
  }

  get size(): number {
    return this.#running.size;
  }

  /** Studio stopped: no turn begins again. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** No turn can begin now: the cap is reached or Studio stopped. */
  get full(): boolean {
    return this.#stopped || this.#running.size >= this.#max;
  }

  /** A new turn, or `null` when `full`; `cause` aborts it too. */
  begin(cause?: AbortSignal): ChatTurn | null {
    if (this.full) return null;
    const controller = new AbortController();
    let settle!: () => void;
    this.#running.set(controller, new Promise<void>((resolve) => (settle = resolve)));
    const timer = setTimeout(
      () =>
        controller.abort(
          new TurnTimeout(`the answer took longer than ${this.#timeoutMs / 60_000} minutes`),
        ),
      this.#timeoutMs,
    );
    // A turn that never ends must not keep a stopped Studio alive.
    timer.unref?.();
    const onCause = () => controller.abort(cause?.reason);
    cause?.addEventListener("abort", onCause, { once: true });
    if (cause?.aborted) onCause();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      cause?.removeEventListener("abort", onCause);
      this.#running.delete(controller);
      settle();
    };
    return {
      signal: controller.signal,
      abandon: () => {
        controller.abort(new Error("the chat agent did not start"));
        end();
      },
      track: (stream) => {
        const reader = stream.getReader();
        // Any abort cancels the agent's stream, read or not; the place frees once its cleanup has.
        let stopping: Promise<void> | null = null;
        const stop = () =>
          (stopping ??= reader
            .cancel(controller.signal.reason)
            .catch(() => {})
            .finally(end));
        controller.signal.addEventListener("abort", () => void stop(), { once: true });
        if (controller.signal.aborted) void stop();
        return new ReadableStream<UIMessageChunk>({
          pull: async (output) => {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch (error) {
              end();
              throw error;
            }
            if (!next.done) return output.enqueue(next.value);
            await stopping;
            const reason: unknown = controller.signal.reason;
            if (reason instanceof TurnTimeout)
              output.enqueue({ type: "error", errorText: reason.message });
            end();
            output.close();
          },
          cancel: async (reason) => {
            controller.abort(reason);
            await stop();
          },
        });
      },
    };
  }

  /** Ends every running turn and waits, bounded, until each has stopped its agent; no turn starts after. */
  async stopAll(): Promise<void> {
    this.#stopped = true;
    for (const controller of this.#running.keys()) controller.abort(new Error("Studio stopped"));
    await within(Promise.all(this.#running.values()), STOP_WAIT_MS);
  }
}
