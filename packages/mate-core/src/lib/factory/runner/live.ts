import type { RunStore } from "./state";

/**
 * A running turn's text and tool activity, for people following the run. Kept in memory
 * only: the stored log stays the record. Each viewer gets a bounded queue, so a slow or
 * lost viewer never holds a turn back; one that falls behind is dropped.
 */

/** What a turn shows while it runs; tool inputs only as a name and a short summary. */
export type TurnEvent =
  | { type: "text"; id?: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "tool-done"; name: string; failed: boolean };

export type LiveEvent =
  | TurnEvent
  /** A log line nobody saw streaming, such as the prompt or a linked change. */
  | { type: "log"; text: string }
  /** The Workset's run ended; its state says what comes next. */
  | { type: "settled" }
  /** The viewer fell behind and was dropped; nothing more arrives. */
  | { type: "lost" };

/** Events a viewer may hold unread before it is dropped. */
export const VIEWER_BUFFER = 2000;

export interface LiveViewer {
  /** The stored log and the text blocks still streaming when the viewer joined. */
  replay: Promise<{ log: string; open: { id: string; text: string }[] }>;
  /** The next event after the replay, or `null` once closed. */
  next(): Promise<LiveEvent | null>;
  close(): void;
}

interface Viewer {
  queue: LiveEvent[];
  wake: (() => void) | null;
  closed: boolean;
}

interface Feed {
  viewers: Set<Viewer>;
  /** Text blocks streaming now, by id; logged whole once they end. */
  open: Map<string, string>;
  /** Log writes and replay reads, in order. */
  chain: Promise<unknown>;
}

export class LiveTurns {
  private readonly feeds = new Map<string, Feed>();
  private readonly settledListeners = new Set<(id: string) => void>();

  constructor(private readonly store: Pick<RunStore, "log" | "readLog">) {}

  private feed(id: string): Feed {
    let feed = this.feeds.get(id);
    if (!feed) {
      feed = { viewers: new Set(), open: new Map(), chain: Promise.resolve() };
      this.feeds.set(id, feed);
    }
    return feed;
  }

  /** Forgets the feed once its writes are stored and nobody watches or streams. */
  private release(id: string, feed: Feed): void {
    const chain = feed.chain;
    void chain.then(() => {
      const idle = feed.chain === chain && feed.viewers.size === 0 && feed.open.size === 0;
      if (idle && this.feeds.get(id) === feed) this.feeds.delete(id);
    });
  }

  private send(feed: Feed, event: LiveEvent): void {
    for (const viewer of feed.viewers) {
      if (viewer.queue.length >= VIEWER_BUFFER) {
        viewer.queue = [{ type: "lost" }];
        viewer.closed = true;
        feed.viewers.delete(viewer);
      } else viewer.queue.push(event);
      viewer.wake?.();
    }
  }

  publish(id: string, event: TurnEvent | { type: "settled" }): void {
    const feed = this.feed(id);
    if (event.type === "text" && event.id !== undefined) {
      feed.open.set(event.id, (feed.open.get(event.id) ?? "") + event.delta);
    } else if (event.type === "text-end") feed.open.delete(event.id);
    // A turn cut short may leave blocks open; they end with the run.
    else if (event.type === "settled") feed.open.clear();
    this.send(feed, event);
    if (event.type === "settled") {
      this.release(id, feed);
      for (const listener of this.settledListeners) listener(id);
    }
  }

  /** Calls `listener` whenever any Workset's run ends, so a board can update without watching each. */
  onSettled(listener: (id: string) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /**
   * Appends to the stored log. `streamed` text reached viewers already as it streamed;
   * anything else is sent as a log line.
   */
  log(id: string, text: string, streamed = false): Promise<void> {
    const feed = this.feed(id);
    if (!streamed) this.send(feed, { type: "log", text });
    const write = feed.chain.then(() => this.store.log(id, text)).catch(() => {});
    feed.chain = write;
    this.release(id, feed);
    return write;
  }

  /** Resolves once every log write queued so far is stored. */
  async flushed(id: string): Promise<void> {
    await this.feed(id).chain;
  }

  /**
   * Joins the Workset's feed. The replay is read after every write queued before joining
   * and before any queued after, and the open blocks are taken at the same moment, so the
   * replay and the events that follow show each part exactly once.
   */
  watch(id: string): LiveViewer {
    const feed = this.feed(id);
    const viewer: Viewer = { queue: [], wake: null, closed: false };
    feed.viewers.add(viewer);
    const open = [...feed.open].map(([block, text]) => ({ id: block, text }));
    const replay = feed.chain.then(async () => ({ log: await this.store.readLog(id), open }));
    // The chain must not hold the replayed log.
    feed.chain = replay.then(
      () => {},
      () => {},
    );
    return {
      replay,
      next: async () => {
        while (viewer.queue.length === 0 && !viewer.closed) {
          // oxlint-disable-next-line no-await-in-loop -- waits for the next event
          await new Promise<void>((resolve) => {
            viewer.wake = resolve;
          });
          viewer.wake = null;
        }
        return viewer.queue.shift() ?? null;
      },
      close: () => {
        viewer.closed = true;
        feed.viewers.delete(viewer);
        viewer.wake?.();
        this.release(id, feed);
      },
    };
  }
}
