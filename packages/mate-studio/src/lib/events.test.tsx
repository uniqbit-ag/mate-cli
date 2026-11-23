import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { StudioConnectionState } from "@uniqbit/mate-core/studio";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

await import("../../test/dom");
const { act, render } = await import("@testing-library/react");
const { useStudioEvents } = await import("./events");
const { startConnectionMonitor, studioConnection, useConnectionState } =
  await import("../stores/connection");

/** An event stream the test opens, fails and closes by hand. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.dispatchEvent(new Event("error"));
  }
}

const realEventSource = globalThis.EventSource;
beforeAll(() => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});
afterAll(() => {
  globalThis.EventSource = realEventSource;
});

afterEach(() => {
  studioConnection()?.dispose();
  FakeEventSource.opened = [];
  useConnectionState.setState({ state: "online" });
});

function Events() {
  useStudioEvents("abcdef0123");
  return null;
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function follow() {
  const answers: ((state: StudioConnectionState) => void)[] = [];
  startConnectionMonitor({
    queryClient: new QueryClient(),
    probe: () => new Promise((resolve) => answers.push(resolve)),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Events />
    </QueryClientProvider>,
  );
  return { answers };
}

describe("studio event stream", () => {
  it("probes on an error and reopens a closed stream for the same companion once online", async () => {
    const page = await follow();
    const [first] = FakeEventSource.opened;
    first!.fail(FakeEventSource.CLOSED);
    expect(page.answers).toHaveLength(1);
    page.answers[0]!("offline");
    await settle();
    expect(FakeEventSource.opened).toHaveLength(1);
    window.dispatchEvent(new Event("online"));
    page.answers[1]!("online");
    await settle();
    expect(FakeEventSource.opened.map((source) => source.url)).toEqual([
      "/api/events?companion=abcdef0123",
      "/api/events?companion=abcdef0123",
    ]);
  });

  it("leaves a stream the browser still reconnects to it", async () => {
    const page = await follow();
    FakeEventSource.opened[0]!.fail(FakeEventSource.CONNECTING);
    page.answers[0]!("offline");
    await settle();
    window.dispatchEvent(new Event("online"));
    page.answers[1]!("online");
    await settle();
    expect(FakeEventSource.opened).toHaveLength(1);
  });
});
