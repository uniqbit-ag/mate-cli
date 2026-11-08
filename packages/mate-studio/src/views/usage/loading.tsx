import { Spinner } from "../../components/ui/spinner";

export function UsageLoading() {
  return (
    <div className="grid min-h-64 flex-1 place-items-center px-6 py-12" role="status">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <Spinner aria-hidden="true" className="size-7 text-accent" />
        <p className="text-sm font-medium">Collecting usage…</p>
        <p className="text-xs leading-relaxed text-muted">
          Reading local usage for this companion and its linked repositories.
        </p>
      </div>
    </div>
  );
}
