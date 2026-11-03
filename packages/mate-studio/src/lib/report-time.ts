const pad = (part: number): string => String(part).padStart(2, "0");

/** A report's local publishing time, the same in every view and independent of the locale. */
export function formatReportTime(createdAt: number): string {
  const at = new Date(createdAt);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}
