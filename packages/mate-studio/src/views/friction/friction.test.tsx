import { afterEach, describe, expect, mock, test } from "bun:test";
import type { FrictionReport, FrictionView } from "@uniqbit/mate-core/studio";

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

const empty = { events: 0, sessions: 0, groups: [], freeReports: [] };
const reportsOnly = (freeReports: FrictionReport[]) =>
  panel(frictionFixture({ ...empty, freeReports }));

const ARTIFACT_GROUP = "The artifact check refused a file write";
const groupRow = (page: ReturnType<typeof panel>) =>
  page.getByRole("heading", { name: ARTIFACT_GROUP }).closest("details")!;

/** Happy DOM does not toggle `details` on a click, so the row is opened directly. */
function openGroup(page: ReturnType<typeof panel>) {
  const row = groupRow(page);
  row.open = true;
  return row.lastElementChild!;
}

describe("the friction list", () => {
  test("a collapsed row shows the counts and keeps the evidence behind its summary", () => {
    const page = panel(
      frictionFixture({ groups: [frictionGroup({ reports: [frictionReport()] })] }),
    );
    const row = groupRow(page);
    const summary = row.querySelector("summary")!;
    expect(row.open).toBe(false);
    for (const count of ["5 events", "2 sessions", "at most 3 in one session", "1 report"]) {
      expect(within(summary).getByText(count)).toBeDefined();
    }
    expect(summary.textContent).toContain("last seen");
    expect(summary.textContent).not.toContain("refusal:artifact:write");
  });

  test("an open row shows the fingerprint, times, versions and paths", () => {
    const page = panel(frictionFixture());
    const text = openGroup(page).textContent!;
    expect(text).toContain("refusal:artifact:write");
    expect(text).toContain("First seen");
    expect(text).toContain("1.0.0 ×5");
    expect(text).toContain("notes.md ×2");
  });

  test("a recurrence across midnight shows both calendar dates in text", () => {
    const first = new Date(2026, 10, 9, 23, 50);
    const last = new Date(2026, 10, 10, 0, 10);
    const page = panel(
      frictionFixture({
        groups: [frictionGroup({ firstSeen: first.toISOString(), lastSeen: last.toISOString() })],
      }),
    );
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
    const times = openGroup(page).querySelectorAll("time");
    expect(times[0]!.textContent).toContain(date.format(first));
    expect(times[1]!.textContent).toContain(date.format(last));
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

  test("an open group shows its reports", () => {
    const page = panel(
      frictionFixture({ groups: [frictionGroup({ reports: [frictionReport()] })] }),
    );
    openGroup(page);
    const reports = page.getByRole("region", { name: `Reports on ${ARTIFACT_GROUP}` });
    expect(reports.textContent).toContain("bug");
    expect(reports.textContent).toContain("Expected: editing a tracked Markdown file is allowed");
  });
});

describe("the agent reports", () => {
  const freeReport = (fields: Partial<FrictionReport> = {}) =>
    frictionReport({
      eventId: null,
      kind: "unclear",
      subject: "skill:mate-apply-change",
      evidence: "step 3 names no branch",
      ...fields,
    });
  const agentReports = (fields?: Partial<FrictionReport>) =>
    reportsOnly([freeReport(fields)]).getByRole("region", { name: "Agent reports" });

  test("stand apart under their subject and say they have no event", () => {
    const page = reportsOnly([freeReport()]);
    const section = page.getByRole("region", { name: "Agent reports" });
    expect(section.textContent).toContain("not attached to a recorded event");
    expect(
      within(section).getByRole("heading", { level: 3, name: "skill:mate-apply-change" }),
    ).toBeDefined();
    expect(page.queryByRole("region", { name: "Recorded friction" })).toBeNull();
  });

  test("lead with the expected text, before the evidence", () => {
    expect(agentReports().textContent).toMatch(/Expected: editing.*Evidence: step 3/);
  });

  test("without expected text still show kind, cost, evidence and workaround", () => {
    const text = agentReports({
      expected: "",
      workaround: "named the branch by hand",
    }).textContent!;
    expect(text).not.toContain("Expected:");
    for (const part of [
      "unclear",
      "detour",
      "Evidence: step 3 names no branch",
      "Workaround: named the branch by hand",
    ]) {
      expect(text).toContain(part);
    }
  });

  test("keep the instant of each report machine-readable", () => {
    expect(agentReports().querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-11-10T09:30:00Z",
    );
  });
});

describe("the overview", () => {
  const reports = ["r1", "r2", "r3", "r4"].map((id) => frictionReport({ id, eventId: null }));
  const overviewOf = (page: ReturnType<typeof panel>) =>
    page.getByRole("region", { name: "Overview" });

  test("counts events and reports apart and comes before the lists", () => {
    const page = panel(
      frictionFixture({
        events: 5,
        sessions: 2,
        groups: [
          frictionGroup(),
          frictionGroup({ fingerprint: "b", title: "B" }),
          frictionGroup({ fingerprint: "c", title: "C" }),
        ],
        freeReports: reports,
      }),
    );
    const overview = overviewOf(page);
    expect(overview.textContent).toContain("5 events in 2 sessions in the last 30 days");
    expect(overview.textContent).toContain("selected companion");
    expect(within(overview).getByRole("link", { name: "Recorded friction 3" })).toBeDefined();
    expect(within(overview).getByRole("link", { name: "Agent reports 4" })).toBeDefined();
    const list = page.getByRole("region", { name: "Recorded friction" });
    expect(overview.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("with reports only links to them and to no recorded friction", () => {
    const overview = overviewOf(reportsOnly(reports));
    expect(overview.textContent).toContain("0 events in 0 sessions");
    expect(
      within(overview)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Agent reports4"]);
  });

  test("each link is a native anchor on its section, so the keyboard can follow it", () => {
    const page = panel(frictionFixture({ freeReports: reports }));
    for (const name of ["Recorded friction", "Agent reports"]) {
      const link = within(overviewOf(page)).getByRole("link", { name: new RegExp(name) });
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toBe(`#${page.getByRole("region", { name }).id}`);
    }
  });

  test("is not shown with no record, and nothing names mate triage", () => {
    const page = panel(frictionFixture(empty));
    expect(page.queryByRole("region", { name: "Overview" })).toBeNull();
    expect(page.container.textContent).not.toContain("triage");
  });
});

describe("the friction states", () => {
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
  const expectTriage = (page: ReturnType<typeof panel>) => {
    const overview = page.getByRole("region", { name: "Overview" });
    expect(overview.textContent).toContain("mate triage");
    expect(overview.textContent).toContain("own terminal, inside the affected repository");
    expect(within(overview).getByRole("button", { name: "Copy" }).dataset.copy).toBe("mate triage");
  };

  test("the overview names mate triage with a copy control when events exist", () => {
    expectTriage(panel(frictionFixture()));
  });

  test("the overview names mate triage when only reports exist", () => {
    expectTriage(reportsOnly([frictionReport({ eventId: null })]));
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
  test("says it reaches all companions on the machine that runs Studio", () => {
    const page = panel(frictionFixture());
    expect(
      page.getByRole("button", {
        name: "Turn recording off",
        description: "Applies to all companions on the machine that runs Studio.",
      }),
    ).toBeDefined();
  });

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
