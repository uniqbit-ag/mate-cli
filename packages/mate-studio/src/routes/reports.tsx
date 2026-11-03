import { createFileRoute } from "@tanstack/react-router";

import { Reports } from "../views/reports/reports-view";

export const Route = createFileRoute("/reports")({
  staticData: { view: "reports" },
  component: function ReportsRoute() {
    const { companion } = Route.useSearch();
    return companion ? <Reports companion={companion} /> : null;
  },
});
