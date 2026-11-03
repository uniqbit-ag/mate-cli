export interface ReportSummary {
  id: string;
  title: string;
  createdAt: number;
}

/** The report the address names, as `#report=<id>`. */
export const REPORT_ID = /(?:^|[#&])report=([0-9a-f]{32})/;

export const reportsQuery = (companion: string) => ({
  queryKey: ["reports", companion],
  queryFn: async (): Promise<ReportSummary[]> => {
    const response = await fetch(`/api/reports?companion=${encodeURIComponent(companion)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    return ((await response.json()) as { reports: ReportSummary[] }).reports ?? [];
  },
});
