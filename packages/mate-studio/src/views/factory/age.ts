/** Whole days, hours or minutes since `iso`, for an age; empty without a render time. */
export function ageText(iso: string, now: number | undefined): string {
  if (now === undefined) return "";
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes >= 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}
