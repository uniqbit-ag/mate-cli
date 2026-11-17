import { afterEach, describe, expect, mock, test } from "bun:test";
import type { FrictionView } from "@uniqbit/mate-core/studio";

await import("../../../test/dom");
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { frictionFixture, frictionGroup, frictionReport } = await import("./fixture");

/** What the server answers; tests replace them per case. */
const server = {
  read: async (_input: { companion: string; days: number }): Promise<FrictionView> =>
    frictionFixture(),
  write: async ({ recording }: { recording: boolean }) => ({ recording }),
};
const real = await import("../../server/friction");
mock.module("../../server/friction", () => ({
  ...real,
  getFriction: ({ data }: { data: { companion: string; days: number } }) => server.read(data),
  setFrictionRecording: ({ data }: { data: { recording: boolean } }) => server.write(data),
}));
const { Friction, FrictionPanel } = await import("./friction-view");
const { frictionQuery } = await import("../../lib/friction-query");

afterEach(cleanup);

const idle = { pending: false, onChange() {} };
const panel = (view: FrictionView, toggle = idle) =>
  render(<FrictionPanel view={view} days={30} onDays={() => {}} toggle={toggle} />);
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

function mount(client = new QueryClient(), companion = "0123456789") {
  return render(
    <QueryClientProvider client={client}>
      <Friction companion={companion} days={30} onDays={() => {}} />
    </QueryClientProvider>,
  );
}

describe("the friction list", () => {
  test("a group shows its sentence, fingerprint, counts, versions and paths", () => {
    const page = panel(frictionFixture());
    const group = page.getByRole("heading", { name: "The artifact check refused a file write" })
      .parentElement!.parentElement!;
    const text = group.textContent!;
    expect(text).toContain("refusal:artifact:write");
    expect(text).toContain("5 events in 2 sessions, at most 3 in one session");
    expect(text).toContain("1.0.0 ×5");
    expect(text).toContain("notes.md ×2");
    expect(page.getByText("6 events in 3 sessions", { exact: false })).toBeDefined();
  });

  test("groups keep core's ranked order", () => {
    const page = panel(frictionFixture());
    expect(
      page.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      "The artifact check refused a file write",
      "mate artifact archive failed with exit code 1",
    ]);
  });

  test("a group shows its reports; a free report is shown apart, with its subject", () => {
    const page = panel(
      frictionFixture({
        groups: [frictionGroup({ reports: [frictionReport()] })],
        freeReports: [
          frictionReport({
            id: "r2",
            eventId: null,
            kind: "unclear",
            subject: "skill:mate-apply-change",
            evidence: "step 3 names no branch",
          }),
        ],
      }),
    );
    const reports = page.getByRole("region", {
      name: "Reports on The artifact check refused a file write",
    });
    expect(reports.textContent).toContain("bug");
    expect(reports.textContent).toContain("Expected: editing a tracked Markdown file is allowed");
    const free = page.getByRole("region", { name: "Free reports" });
    expect(free.textContent).toContain("skill:mate-apply-change");
    expect(free.textContent).toContain("Evidence: step 3 names no branch");
    expect(page.getAllByRole("heading", { level: 3 })).toHaveLength(1);
  });
});

describe("the friction states", () => {
  const empty = { events: 0, sessions: 0, groups: [], freeReports: [] };

  test("recording off and no record explains recording and offers the control", () => {
    const page = panel(frictionFixture({ ...empty, recording: false }));
    expect(page.container.textContent).toContain("Friction recording shows where Mate gets in");
    expect(page.getByText("Recording is off")).toBeDefined();
    expect(page.getByRole("button", { name: "Turn recording on" })).toBeDefined();
  });

  test("recording off with records says so and still lists them", () => {
    const page = panel(frictionFixture({ recording: false }));
    expect(page.container.textContent).toContain("Recording is off: nothing new is recorded.");
    expect(page.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  test("recording on with no record says nothing was recorded in the period", () => {
    const page = panel(frictionFixture(empty));
    expect(page.container.textContent).toContain("No friction was recorded in the last 30 days.");
    expect(page.container.textContent).not.toContain("Friction recording shows");
  });

  test("a failed load shows an error with Retry", async () => {
    let reads = 0;
    server.read = async () => {
      reads++;
      throw new Error("unreadable");
    };
    const page = mount();
    await settle();
    expect(page.getByRole("alert").textContent).toContain("could not be read");
    server.read = async () => frictionFixture();
    fireEvent.click(page.getByRole("button", { name: "Retry" }));
    await settle();
    expect(reads).toBe(1);
    expect(page.getByText("Recording is on")).toBeDefined();
  });

  test("a failed reload shows the error and Retry above the records it keeps", async () => {
    server.read = async () => frictionFixture();
    const client = new QueryClient();
    const page = mount(client);
    await settle();
    server.read = async () => {
      throw new Error("unreadable");
    };
    await act(() => client.invalidateQueries());
    await settle();
    expect(page.getByRole("alert").textContent).toContain("could not be read");
    expect(page.getByRole("button", { name: "Retry" })).toBeDefined();
    expect(page.getAllByRole("heading", { level: 3 })).toHaveLength(2);
    client.clear();
  });
});

describe("the next action", () => {
  test("names mate triage, the person's terminal and the repository, with a copy control", () => {
    const page = panel(frictionFixture());
    const next = page.getByRole("region", { name: "Next action" });
    expect(next.textContent).toContain("mate triage");
    expect(next.textContent).toContain("own terminal, inside the affected repository");
    expect(within(next).getByRole("button", { name: "Copy" }).dataset.copy).toBe("mate triage");
  });

  test("is not shown with no record", () => {
    const page = panel(frictionFixture({ events: 0, sessions: 0, groups: [], freeReports: [] }));
    expect(page.queryByRole("region", { name: "Next action" })).toBeNull();
    expect(page.container.textContent).not.toContain("triage");
  });
});

describe("the period", () => {
  test("offers 7, 30 and 90 days and marks the one shown", () => {
    const chosen: number[] = [];
    const page = render(
      <FrictionPanel
        view={frictionFixture()}
        days={30}
        onDays={(days) => chosen.push(days)}
        toggle={idle}
      />,
    );
    expect(page.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(page.getByRole("button", { name: "90 days" }));
    expect(chosen).toEqual([90]);
  });

  test("a late answer for one companion never fills another's view", async () => {
    const client = new QueryClient();
    const late = Promise.withResolvers<FrictionView>();
    const first = client.fetchQuery({
      ...frictionQuery("0123456789", 30),
      queryFn: () => late.promise,
    });
    client.setQueryData(frictionQuery("9876543210", 30).queryKey, frictionFixture({ events: 1 }));
    late.resolve(frictionFixture({ events: 9 }));
    await first;
    expect(client.getQueryData(frictionQuery("9876543210", 30).queryKey)?.events).toBe(1);
    expect(client.getQueryData(frictionQuery("0123456789", 90).queryKey)).toBeUndefined();
    client.clear();
  });
});

describe("the recording control", () => {
  test("is disabled while pending, then shows the new state and refetches every friction query", async () => {
    server.read = async () => frictionFixture({ recording: false });
    const written = Promise.withResolvers<{ recording: boolean }>();
    server.write = () => written.promise;
    const client = new QueryClient();
    client.setQueryData(frictionQuery("9876543210", 7).queryKey, frictionFixture());
    const page = mount(client);
    await settle();
    fireEvent.click(page.getByRole("button", { name: "Turn recording on" }));
    await settle();
    expect(
      (page.getByRole("button", { name: "Turn recording on" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    server.read = async () => frictionFixture({ recording: true });
    written.resolve({ recording: true });
    await settle();
    expect(page.getByText("Recording is on")).toBeDefined();
    expect(client.getQueryState(frictionQuery("9876543210", 7).queryKey)?.isInvalidated).toBe(true);
    client.clear();
  });

  test("a failed change keeps the earlier state and shows an error", async () => {
    server.read = async () => frictionFixture({ recording: true });
    server.write = async () => {
      throw new Error("settings file is read-only");
    };
    const page = mount();
    await settle();
    fireEvent.click(page.getByRole("button", { name: "Turn recording off" }));
    await settle();
    expect(page.getByText("Recording is on")).toBeDefined();
    expect(page.getByRole("alert").textContent).toBe(
      "Recording could not be turned off: settings file is read-only",
    );
  });
});
