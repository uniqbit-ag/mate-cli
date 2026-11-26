import { afterEach, describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import type {
  FrictionFreeReport,
  FrictionMarkResult,
  FrictionView,
} from "@uniqbit/mate-core/studio";

import type { FrictionMarkInput } from "../../server/friction";
import type { FrictionFilters } from "./select-friction";

await import("../../../test/dom");
const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { frictionFixture, frictionFreeReport, frictionGroup, frictionReport, frictionState } =
  await import("./fixture");

const server = {
  read: async (_input: { companion: string; days: number }): Promise<FrictionView> =>
    frictionFixture(),
  readSwitch: async (): Promise<{ recording: boolean }> => ({ recording: false }),
  write: async ({ recording }: { recording: boolean }) => ({ recording }),
  mark: async (_input: FrictionMarkInput): Promise<FrictionMarkResult> => ({
    ok: true,
    state: null,
  }),
};
const real = await import("../../server/friction");
mock.module("../../server/friction", () => ({
  ...real,
  getFriction: ({ data }: { data: { companion: string; days: number } }) => server.read(data),
  getFrictionRecording: () => server.readSwitch(),
  setFrictionRecording: ({ data }: { data: { recording: boolean } }) => server.write(data),
  markFriction: ({ data }: { data: FrictionMarkInput }) => server.mark(data),
}));
const { Friction, FrictionPanel } = await import("./friction-view");
const { GlobalFeatures } = await import("../../shell/global-features");
const { frictionQuery, frictionRecordingQuery } = await import("../../lib/friction-query");
const { validateStudioSearch } = await import("../../lib/search");
const { DEFAULT_FRICTION_FILTERS, filtersFromSearch } = await import("./select-friction");

afterEach(cleanup);

const idle = { pending: false, onChange() {} };
const unmarked = async () => ({ ok: true, state: null }) as const;
const panel = (
  view: FrictionView,
  toggle = idle,
  filters = DEFAULT_FRICTION_FILTERS,
  onFilters = (_filters: FrictionFilters) => {},
) =>
  render(
    <FrictionPanel
      view={view}
      days={30}
      onDays={() => {}}
      toggle={toggle}
      filters={filters}
      onFilters={onFilters}
      mark={unmarked}
    />,
  );
const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)));

function mount(
  client = new QueryClient(),
  companion = "0123456789",
  filters = DEFAULT_FRICTION_FILTERS,
) {
  return render(
    <QueryClientProvider client={client}>
      <Friction
        companion={companion}
        days={30}
        onDays={() => {}}
        filters={filters}
        onFilters={() => {}}
      />
    </QueryClientProvider>,
  );
}

const empty = { events: 0, sessions: 0, groups: [], freeReports: [] };
const reportsOnly = (freeReports: FrictionFreeReport[]) =>
  panel(frictionFixture({ ...empty, freeReports }));

const ARTIFACT_GROUP = "The artifact check refused a file write";
const SUBJECT = "skill:mate-apply-change";
const rowOf = (page: ReturnType<typeof panel>, heading: string) =>
  page.getByRole("heading", { name: heading }).closest("details")!;
const groupRow = (page: ReturnType<typeof panel>) => rowOf(page, ARTIFACT_GROUP);

/** Happy DOM does not toggle `details` on a click, so the row is opened directly. */
function openRow(row: HTMLDetailsElement) {
  row.open = true;
  return row.lastElementChild as HTMLElement;
}
const openGroup = (page: ReturnType<typeof panel>) => openRow(groupRow(page));
const fields = (element: HTMLElement) =>
  [...element.querySelectorAll("dt")]
    .map((term) => `${term.textContent}: ${term.nextElementSibling!.textContent}`)
    .join(" ");

function expectActionsOnlyWhenOpen(page: ReturnType<typeof panel>, heading: string) {
  expect(page.queryByRole("group", { name: `Mark ${heading}` })).toBeNull();
  const body = within(openRow(rowOf(page, heading)));
  for (const action of ["Mark fixed", "Mark reported", "Dismiss"]) {
    expect(body.getByRole("button", { name: action })).toBeDefined();
  }
}

describe("the friction list", () => {
  test("a collapsed row leads with the most in one session and keeps the evidence behind it", () => {
    const page = panel(
      frictionFixture({ groups: [frictionGroup({ reports: [frictionReport()] })] }),
    );
    const row = groupRow(page);
    const summary = row.querySelector("summary")!;
    expect(row.open).toBe(false);
    expect(summary.textContent).toMatch(
      /at most 3 in one session.*5 events.*2 sessions.*1 report.*last seen/,
    );
    expect(summary.textContent).not.toContain("refusal:artifact:write");
  });

  test("a collapsed group offers no mark action; opened, it offers them", () => {
    expectActionsOnlyWhenOpen(panel(frictionFixture()), ARTIFACT_GROUP);
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
    expect(fields(reports)).toContain("Expected: editing a tracked Markdown file is allowed");
  });
});

describe("the per-item triage command", () => {
  const triageOf = (page: ReturnType<typeof panel>, heading: string) =>
    page.queryByRole("group", { name: `Triage ${heading}` });
  const command = (group: HTMLElement) => ({
    shown: group.querySelector("code")!.textContent,
    copied: group.querySelector("[data-copy]")!.getAttribute("data-copy"),
  });

  test("an opened group copies exactly its quoted fingerprint; collapsed, it shows none", () => {
    const page = panel(
      frictionFixture({ groups: [frictionGroup({ fingerprint: "command:artifact submit:1" })] }),
    );
    expect(triageOf(page, ARTIFACT_GROUP)).toBeNull();
    openGroup(page);
    const expected = 'mate triage "command:artifact submit:1"';
    expect(command(triageOf(page, ARTIFACT_GROUP)!)).toEqual({
      shown: expected,
      copied: expected,
    });
  });

  test("a dismissed Agent report shows its triage command", () => {
    const page = panel(
      frictionFixture({
        groups: [],
        freeReports: [
          frictionFreeReport({
            id: "r-dismissed",
            subject: SUBJECT,
            state: {
              state: "dismissed",
              at: "2026-11-10T10:00:00Z",
              by: "person",
              note: null,
              link: null,
            },
            open: false,
          }),
        ],
      }),
      idle,
      { ...DEFAULT_FRICTION_FILTERS, state: "handled" },
    );
    openRow(rowOf(page, SUBJECT));
    expect(command(triageOf(page, SUBJECT)!).copied).toBe("mate triage r-dismissed");
  });
});

describe("the agent reports", () => {
  const freeReport = (fields: Partial<FrictionFreeReport> = {}) =>
    frictionFreeReport({
      kind: "unclear",
      subject: SUBJECT,
      evidence: "step 3 names no branch",
      ...fields,
    });
  const agentReports = (fields?: Partial<FrictionFreeReport>) =>
    reportsOnly([freeReport(fields)]).getByRole("region", { name: "Agent reports" });

  test("are collapsed rows naming subject and kind, with no mark action until opened", () => {
    const page = reportsOnly([freeReport()]);
    const summary = rowOf(page, SUBJECT).querySelector("summary")!;
    expect(summary.textContent).toContain("unclear");
    expect(summary.textContent).not.toContain("Expected");
    expectActionsOnlyWhenOpen(page, SUBJECT);
  });

  test("open from a native summary and lead with the expected text, before the evidence", () => {
    const row = rowOf(reportsOnly([freeReport()]), SUBJECT);
    expect(row.firstElementChild!.tagName).toBe("SUMMARY");
    expect(fields(openRow(row))).toMatch(/^Expected: editing.*Evidence: step 3/);
  });

  test("stand apart under their subject and say they have no event", () => {
    const page = reportsOnly([freeReport()]);
    const section = page.getByRole("region", { name: "Agent reports" });
    expect(section.textContent).toContain("not attached to a recorded event");
    expect(within(section).getByRole("heading", { level: 3, name: SUBJECT })).toBeDefined();
    expect(page.queryByRole("region", { name: "Recorded friction" })).toBeNull();
  });

  test("without expected text still show kind, cost, evidence and workaround", () => {
    const region = agentReports({
      expected: "",
      workaround: "named the branch by hand",
    });
    const text = `${region.textContent} ${fields(region)}`;
    expect(text).not.toContain("Expected");
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
  const reports = ["r1", "r2", "r3", "r4"].map((id) => frictionFreeReport({ id }));
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
    const retried = Promise.withResolvers<FrictionView>();
    server.read = () => retried.promise;
    fireEvent.click(page.getByRole("button", { name: "Retry" }));
    await settle();
    retried.resolve(frictionFixture());
    await settle();
    expect(reads).toBe(1);
    expect(page.getByText("Recording is on")).toBeDefined();
    expect(document.activeElement).toBe(page.getByRole("button", { name: "Turn recording off" }));
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
    expectTriage(reportsOnly([frictionFreeReport()]));
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
        filters={DEFAULT_FRICTION_FILTERS}
        onFilters={() => {}}
        mark={unmarked}
      />,
    );
    expect(page.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(page.getByRole("button", { name: "90 days" }));
    expect(chosen).toEqual([90]);
  });

  test("choosing a period not yet read keeps the period control in place and focused", async () => {
    server.read = async () => frictionFixture();
    const client = new QueryClient();
    function Periods() {
      const [days, setDays] = useState<30 | 90>(30);
      return (
        <QueryClientProvider client={client}>
          <Friction
            companion="0123456789"
            days={days}
            onDays={(next) => setDays(next as 30 | 90)}
            filters={DEFAULT_FRICTION_FILTERS}
            onFilters={() => {}}
          />
        </QueryClientProvider>
      );
    }
    const page = render(<Periods />);
    await settle();
    server.read = () => new Promise(() => {});
    const ninety = page.getByRole("button", { name: "90 days" });
    ninety.focus();
    fireEvent.click(ninety);
    await settle();
    expect(document.activeElement).toBe(ninety);
    expect(page.getByRole("region", { name: "Overview" }).textContent).toContain("last 30 days");
    client.clear();
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

  test("a change reaches another companion's friction and the start page's state", async () => {
    server.read = async () => frictionFixture({ recording: false });
    server.write = async ({ recording }) => ({ recording });
    const client = new QueryClient();
    const other = frictionQuery("9876543210", 7).queryKey;
    client.setQueryData(other, frictionFixture({ recording: false }));
    client.setQueryData(frictionRecordingQuery.queryKey, { recording: false });
    const page = mount(client);
    await settle();
    fireEvent.click(page.getByRole("button", { name: "Turn recording on" }));
    await settle();
    expect(client.getQueryData(other)?.recording).toBe(true);
    expect(client.getQueryData(frictionRecordingQuery.queryKey)).toEqual({ recording: true });
    client.clear();
  });

  describe("while a change made here is saving, the start page", () => {
    async function leaveDuringSave(client: InstanceType<typeof QueryClient>) {
      server.read = async () => frictionFixture({ recording: false });
      const written = Promise.withResolvers<{ recording: boolean }>();
      server.write = () => written.promise;
      const page = mount(client);
      await settle();
      fireEvent.click(page.getByRole("button", { name: "Turn recording on" }));
      await settle();
      page.unmount();
      const start = render(
        <QueryClientProvider client={client}>
          <GlobalFeatures />
        </QueryClientProvider>,
      );
      await settle();
      return { written, startPage: within(start.container) };
    }

    test("holds its control too", async () => {
      server.readSwitch = async () => ({ recording: false });
      const client = new QueryClient();
      client.setQueryData(frictionRecordingQuery.queryKey, { recording: false });
      const { written, startPage } = await leaveDuringSave(client);
      const control = startPage.getByRole<HTMLButtonElement>("button", {
        name: "Turn recording on",
      });
      expect(control.disabled).toBe(true);
      written.resolve({ recording: true });
      await settle();
      client.clear();
    });

    test("does not keep a first read that started before the change landed", async () => {
      const early = Promise.withResolvers<{ recording: boolean }>();
      server.readSwitch = () => early.promise;
      const client = new QueryClient();
      const { written, startPage } = await leaveDuringSave(client);
      server.readSwitch = async () => ({ recording: true });
      written.resolve({ recording: true });
      await settle();
      early.resolve({ recording: false });
      await settle();
      expect(startPage.getByText("Recording is on")).toBeDefined();
      client.clear();
    });
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

describe("the filters", () => {
  const handledSkill = frictionFreeReport({
    id: "r-skill",
    subject: "skill:mate-apply-change",
    state: { state: "fixed", at: "2026-11-10T10:00:00Z", by: "person", note: null, link: null },
    open: false,
  });
  const view = frictionFixture({
    freeReports: [handledSkill, frictionFreeReport({ id: "r-open" })],
  });

  test("a reload restores the state and the type from the address", () => {
    const search = validateStudioSearch(
      Object.fromEntries(new URLSearchParams("frictionState=handled&frictionType=skill")),
    );
    const page = panel(view, idle, filtersFromSearch(search));
    expect(
      within(page.getByRole("group", { name: "State" }))
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent),
    ).toEqual(["Handled"]);
    expect(page.getByRole("combobox", { name: "Type" }).textContent).toBe("skill");
    expect(page.queryByRole("region", { name: "Recorded friction" })).toBeNull();
    expect(
      within(page.getByRole("region", { name: "Agent reports" }))
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["skill:mate-apply-change"]);
  });

  test("the type, kind and sort selects show their label and current choice", () => {
    const page = panel(view);
    const shown = (name: string) => page.getByRole("combobox", { name }).textContent;
    expect([shown("Type"), shown("Kind"), shown("Sort")]).toEqual([
      "All types",
      "All kinds",
      "Most repeated in one session",
    ]);
    expect(
      page.getByRole("combobox", { name: "Kind", description: "Agent reports only" }),
    ).toBeDefined();
  });

  test("the kind select is disabled when the period holds no Agent report, unless a kind is chosen", () => {
    const kind = (fixture: FrictionView, filters = DEFAULT_FRICTION_FILTERS) =>
      panel(fixture, idle, filters)
        .getByRole("combobox", { name: "Kind" })
        .hasAttribute("data-disabled");
    expect(kind(frictionFixture())).toBe(true);
    cleanup();
    expect(kind(view)).toBe(false);
    cleanup();
    expect(kind(frictionFixture(), { ...DEFAULT_FRICTION_FILTERS, kind: "bug" })).toBe(false);
  });

  test("choosing a select hands the new filters to the address", async () => {
    const chosen: FrictionFilters[] = [];
    const page = panel(view, idle, undefined, (filters) => chosen.push(filters));
    for (const [name, option] of [
      ["Sort", "Most recent"],
      ["Kind", "bug"],
    ]) {
      await act(async () => {
        fireEvent.click(page.getByRole("combobox", { name }));
      });
      await act(async () => {
        fireEvent.keyDown(page.getByRole("option", { name: option }), { key: "Enter" });
      });
    }
    expect(chosen).toEqual([
      { state: "open", sort: "recent" },
      { state: "open", sort: "repeats", kind: "bug" },
    ]);
  });
});

describe("the hidden items", () => {
  test("the overview counts shown items and offers to show all", () => {
    const chosen: FrictionFilters[] = [];
    const page = panel(
      frictionFixture({
        groups: [
          frictionGroup(),
          frictionGroup({ fingerprint: "b", title: "B" }),
          frictionGroup({
            fingerprint: "c",
            title: "C",
            state: frictionState({ state: "dismissed" }),
            open: false,
          }),
        ],
      }),
      idle,
      undefined,
      (filters) => chosen.push(filters),
    );
    const overview = page.getByRole("region", { name: "Overview" });
    expect(within(overview).getByRole("link", { name: "Recorded friction 2" })).toBeDefined();
    expect(overview.textContent).toContain("1 item is hidden by the filters.");
    fireEvent.click(within(overview).getByRole("button", { name: /Show all/ }));
    expect(chosen).toEqual([{ state: "all", sort: "repeats" }]);
  });

  test("Show all moves focus to the State filter's All, also when only the type hid items", () => {
    const view = frictionFixture();
    function Filtered() {
      const [filters, setFilters] = useState<FrictionFilters>({
        state: "all",
        type: "hook",
        sort: "repeats",
      });
      return (
        <FrictionPanel
          view={view}
          days={30}
          onDays={() => {}}
          toggle={idle}
          filters={filters}
          onFilters={setFilters}
          mark={unmarked}
        />
      );
    }
    const page = render(<Filtered />);
    fireEvent.click(page.getAllByRole("button", { name: /Show all/ })[0]!);
    expect(document.activeElement).toBe(page.getByRole("button", { name: "All" }));
  });

  test("with everything handled says no item matches, not that nothing was recorded", () => {
    const fixed = { state: frictionState(), open: false };
    const page = panel(
      frictionFixture({
        groups: [frictionGroup(fixed), frictionGroup({ fingerprint: "b", ...fixed })],
      }),
    );
    const overview = page.getByRole("region", { name: "Overview" });
    expect(overview.textContent).not.toContain("hidden");
    expect(within(overview).queryByRole("button", { name: /Show all/ })).toBeNull();
    const note = page.getByText(/No item matches the filters\./);
    expect(note.textContent).toContain("2 items are hidden by the filters.");
    expect(within(note).getByRole("button", { name: /Show all/ })).toBeDefined();
    expect(page.container.textContent).not.toContain("No friction was recorded");
  });
});

describe("an item's Friction State", () => {
  test("a reported group from triage shows the link, who, when and the events since", () => {
    const link = "https://github.com/acme/mate/issues/7";
    const page = panel(
      frictionFixture({
        groups: [
          frictionGroup({
            state: frictionState({ state: "reported", by: "triage", link, eventsSince: 2 }),
            open: false,
          }),
        ],
      }),
      idle,
      { state: "all", sort: "repeats" },
    );
    openGroup(page);
    const row = groupRow(page).parentElement!;
    expect(row.textContent).toContain("Reported by triage");
    expect(row.textContent).toContain("2 events since reported");
    expect(
      [...row.querySelectorAll("time")].map((time) => time.getAttribute("dateTime")),
    ).toContain("2026-11-10T10:00:00Z");
    const anchor = within(row).getByRole("link", { name: link });
    expect(anchor.getAttribute("href")).toBe(link);
    expect(anchor.getAttribute("rel")).toBe("noreferrer");
    expect(within(row).getByRole("button", { name: "Reopen" })).toBeDefined();
  });

  test("a reopened group says it was fixed and recorded again, under Open", () => {
    const page = panel(
      frictionFixture({
        groups: [frictionGroup({ state: frictionState({ eventsSince: 1, reopened: true }) })],
      }),
    );
    const row = groupRow(page).parentElement!;
    expect(row.textContent).toContain("Reopened");
    expect(row.textContent).toContain("Fixed, then recorded again");
  });
});

describe("marking", () => {
  const LINK = "https://github.com/acme/mate/issues/7";
  const OTHER_GROUP = "mate artifact archive failed with exit code 1";
  const opened = (page: ReturnType<typeof mount>, heading: string) =>
    within(openRow(rowOf(page, heading)));

  test("a group marked reported leaves the Open list, is announced, and focus moves on", async () => {
    const marks: FrictionMarkInput[] = [];
    const reported = frictionGroup({
      state: frictionState({ state: "reported", by: "studio", link: LINK }),
      open: false,
    });
    server.read = async () => frictionFixture();
    server.mark = async (input) => {
      marks.push(input);
      server.read = async () =>
        frictionFixture({ groups: [reported, frictionFixture().groups[1]!] });
      return { ok: true, state: reported.state };
    };
    const client = new QueryClient();
    const page = mount(client);
    await settle();
    const row = opened(page, ARTIFACT_GROUP);
    fireEvent.click(row.getByRole("button", { name: "Mark reported" }));
    const field = page.getByLabelText("Issue link (optional)");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: LINK } });
    fireEvent.click(row.getByRole("button", { name: "Mark reported" }));
    await settle();
    expect(marks).toEqual([{ target: "refusal:artifact:write", state: "reported", link: LINK }]);
    expect(page.queryByRole("heading", { name: ARTIFACT_GROUP })).toBeNull();
    expect(page.container.querySelector("[aria-live=polite]")!.textContent).toContain(
      `${ARTIFACT_GROUP}: marked reported.`,
    );
    expect(document.activeElement).toBe(
      page.getByRole("heading", { name: OTHER_GROUP }).closest("summary"),
    );
    client.clear();
  });

  test("a group marked under All stays open, shows its new state and keeps focus", async () => {
    server.read = async () => frictionFixture();
    server.mark = async () => {
      server.read = async () =>
        frictionFixture({
          groups: [
            frictionGroup({ state: frictionState({ by: "studio" }), open: false }),
            frictionFixture().groups[1]!,
          ],
        });
      return { ok: true, state: frictionState({ by: "studio" }) };
    };
    const client = new QueryClient();
    const page = mount(client, undefined, { state: "all", sort: "repeats" });
    await settle();
    const row = opened(page, ARTIFACT_GROUP);
    fireEvent.click(row.getByRole("button", { name: "Mark fixed" }));
    fireEvent.click(row.getByRole("button", { name: "Mark fixed" }));
    await settle();
    const details = groupRow(page);
    expect(details.open).toBe(true);
    expect(details.querySelector("summary")!.textContent).toContain("Fixed");
    expect(document.activeElement).toBe(details.querySelector("summary"));
    client.clear();
  });

  test("marking the last shown item moves focus to Show all in the empty message", async () => {
    const only = frictionGroup();
    server.read = async () => frictionFixture({ groups: [only] });
    server.mark = async () => {
      server.read = async () =>
        frictionFixture({ groups: [{ ...only, state: frictionState(), open: false }] });
      return { ok: true, state: frictionState() };
    };
    const client = new QueryClient();
    const page = mount(client);
    await settle();
    const row = opened(page, ARTIFACT_GROUP);
    fireEvent.click(row.getByRole("button", { name: "Mark fixed" }));
    fireEvent.click(row.getByRole("button", { name: "Mark fixed" }));
    await settle();
    expect(document.activeElement).toBe(
      within(page.getByText(/No item matches the filters\./)).getByRole("button", {
        name: /Show all/,
      }),
    );
    client.clear();
  });

  test("a dismissed Agent report reopens from Handled and is open again", async () => {
    const dismissed = frictionFreeReport({
      id: "r-dismissed",
      subject: "docs:acme",
      state: {
        state: "dismissed",
        at: "2026-11-10T10:00:00Z",
        by: "person",
        note: null,
        link: null,
      },
      open: false,
    });
    const marks: FrictionMarkInput[] = [];
    server.read = async () => frictionFixture({ freeReports: [dismissed] });
    server.mark = async (input) => {
      marks.push(input);
      server.read = async () =>
        frictionFixture({ freeReports: [{ ...dismissed, state: null, open: true }] });
      return { ok: true, state: null };
    };
    const client = new QueryClient();
    const page = mount(client, undefined, { state: "handled", sort: "repeats" });
    await settle();
    fireEvent.click(opened(page, "docs:acme").getByRole("button", { name: "Reopen" }));
    await settle();
    expect(marks).toEqual([{ target: "r-dismissed", state: "open" }]);
    page.unmount();
    const open = mount(client);
    await settle();
    expect(
      within(open.getByRole("region", { name: "Agent reports" })).getByText("docs:acme"),
    ).toBeDefined();
    expect(opened(open, "docs:acme").getByRole("button", { name: "Mark fixed" })).toBeDefined();
    client.clear();
  });

  test("a refused note shows the refusal beside the item, not the note, and keeps the state", async () => {
    const note = "acme-note-holding-a-token";
    server.read = async () => frictionFixture();
    server.mark = async () => ({
      ok: false,
      reason: "The mark holds a secret (github-pat); nothing was recorded.",
    });
    const client = new QueryClient();
    const page = mount(client);
    await settle();
    const row = opened(page, ARTIFACT_GROUP);
    fireEvent.click(row.getByRole("button", { name: "Dismiss" }));
    fireEvent.change(page.getByLabelText("Note (optional)"), { target: { value: note } });
    fireEvent.click(row.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(row.getByRole("alert").textContent).toContain("holds a secret");
    expect(row.getByRole("alert").textContent).not.toContain(note);
    expect(groupRow(page).textContent).not.toContain("Dismissed in Studio");
    client.clear();
  });

  test("Escape closes the mark form and returns focus to the action that opened it", () => {
    const page = panel(frictionFixture());
    const row = within(openGroup(page));
    fireEvent.click(row.getByRole("button", { name: "Dismiss" }));
    fireEvent.keyDown(page.getByLabelText("Note (optional)"), { key: "Escape" });
    expect(page.queryByLabelText("Note (optional)")).toBeNull();
    expect(document.activeElement).toBe(row.getByRole("button", { name: "Dismiss" }));
  });

  test("Mark fixed is reached and confirmed from the keyboard once the row is open", async () => {
    const marks: FrictionMarkInput[] = [];
    server.read = async () => frictionFixture();
    server.mark = async (input) => {
      marks.push(input);
      return { ok: true, state: null };
    };
    const client = new QueryClient();
    const page = mount(client);
    await settle();
    const row = opened(page, ARTIFACT_GROUP);
    const fixed = row.getByRole("button", { name: "Mark fixed" });
    expect(fixed.tagName).toBe("BUTTON");
    expect(fixed.tabIndex).toBe(0);
    fixed.focus();
    expect(document.activeElement).toBe(fixed);
    // A native button turns Enter into a click; Happy DOM does not, so the click stands in.
    fireEvent.click(fixed);
    const field = page.getByLabelText("Note (optional)");
    expect(document.activeElement).toBe(field);
    fireEvent.submit(field.closest("form")!);
    await settle();
    expect(marks).toEqual([{ target: "refusal:artifact:write", state: "fixed", note: "" }]);
    client.clear();
  });
});
