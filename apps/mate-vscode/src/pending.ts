/** The part of `mate artifact pending --json` the sidebar reads. */
export interface PendingJson {
  pending?: Array<{ name: string; anchor: string; delivery?: { status?: string } }>;
}

export interface PendingItem {
  name: string;
  anchor: string;
  waitingForMerge: boolean;
}

export function toPendingItems(result: PendingJson): PendingItem[] {
  return (result.pending ?? []).map((entry) => ({
    name: entry.name,
    anchor: entry.anchor,
    waitingForMerge: entry.delivery?.status === "waiting",
  }));
}
