import { REPORT_VIEW_PREFIX } from "../../routes";
import { currentTheme, setThemeListener } from "./theme";

interface ReportSummary {
  id: string;
  title: string;
  createdAt: number;
}

function reportHash(): string | null {
  const match = /(?:^|[#&])report=([0-9a-f]{32})/.exec(location.hash || "");
  return match ? match[1]! : null;
}

/** Hosted reports: the list, the sandboxed frame, and the toast and badge for a new arrival. */
export function wireReports(): void {
  setThemeListener(null);
  const shell = document.querySelector("[data-reports-events-url]");
  if (!shell || typeof EventSource === "undefined") return;
  const current = shell.getAttribute("data-companion");
  const listUrl = shell.getAttribute("data-reports-url");
  const viewUrl = shell.getAttribute("data-reports-view-url");
  const list = document.getElementById("reports-list");
  const frame = document.getElementById("reports-frame") as HTMLIFrameElement | null;
  const open = document.getElementById("reports-open") as HTMLAnchorElement | null;
  const empty = document.getElementById("reports-empty");
  const template = document.getElementById("reports-item-template") as HTMLTemplateElement | null;
  const badge = document.getElementById("reports-badge");
  const toast = document.getElementById("reports-toast");
  const toastTitle = document.getElementById("reports-toast-title");
  const toastOpen = document.getElementById("reports-toast-open") as HTMLAnchorElement | null;
  let shown: string | null = null;
  let toastTimeout: ReturnType<typeof setTimeout> | undefined;

  function show(id: string): void {
    if (!frame) return;
    shown = id;
    const theme = currentTheme();
    const src = `${REPORT_VIEW_PREFIX}${id}${theme === "system" ? "" : `?scheme=${theme}`}`;
    frame.src = src;
    frame.hidden = false;
    if (open) {
      open.href = src;
      open.hidden = false;
    }
    if (list) {
      list.querySelectorAll("button[data-report-id]").forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          button.getAttribute("data-report-id") === id ? "true" : "false",
        );
      });
    }
    try {
      history.replaceState(null, "", `#report=${id}`);
    } catch {
      /* the address is a convenience */
    }
  }

  function render(reports: ReportSummary[]): void {
    const first = template && template.content.firstElementChild;
    if (!list || !template || !first) return;
    list.replaceChildren();
    if (empty) empty.hidden = reports.length > 0;
    for (const report of reports) {
      const item = first.cloneNode(true) as Element;
      const button = item.querySelector("button")!;
      button.setAttribute("data-report-id", report.id);
      button.setAttribute("aria-pressed", report.id === shown ? "true" : "false");
      item.querySelector("[data-report-title]")!.textContent = report.title;
      item.querySelector("[data-report-time]")!.textContent = new Date(
        report.createdAt,
      ).toLocaleString();
      button.addEventListener("click", () => show(report.id));
      list.append(item);
    }
    if (reports.length === 0 || reports.some((report) => report.id === shown)) return;
    const named = reportHash();
    show(reports.some((report) => report.id === named) ? named! : reports[0]!.id);
  }

  function refreshList(): void {
    if (!list || !listUrl) return;
    fetch(listUrl, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(`status ${response.status}`);
        return response.json();
      })
      .then((body) => render(body.reports || []))
      .catch(() => {
        /* the next event or reconnect retries */
      });
  }

  function announceReport(event: { id: string; title: string }): void {
    if (badge) badge.hidden = false;
    if (!toast || !toastTitle) return;
    toastTitle.textContent = `New report: ${event.title}`;
    if (toastOpen && viewUrl) toastOpen.href = `${viewUrl}#report=${event.id}`;
    toast.setAttribute("data-shown", "true");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.setAttribute("data-shown", "false"), 10000);
  }

  setThemeListener(() => {
    if (shown) show(shown);
  });
  const events = new EventSource(shell.getAttribute("data-reports-events-url")!);
  events.addEventListener("open", refreshList);
  events.addEventListener("message", (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!event || event.type !== "report-published" || event.companion !== current) return;
    if (list) refreshList();
    else announceReport(event);
  });
}
