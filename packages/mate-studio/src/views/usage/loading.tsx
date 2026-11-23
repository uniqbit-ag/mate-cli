import { ViewLoading } from "../../components/view-parts";

export function UsageLoading() {
  return (
    <ViewLoading
      title="Collecting usage…"
      detail="Reading local usage for this companion and its linked repositories."
    />
  );
}
