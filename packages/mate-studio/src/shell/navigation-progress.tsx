import { useRouterState } from "@tanstack/react-router";

/**
 * A thin bar along the top while a navigation is pending or a view waits for its first data.
 * The waiting view is seen through its placeholder in the stylesheet, so background refreshes
 * of held data, which show no placeholder, stay quiet.
 */
export function NavigationProgress() {
  const pending = useRouterState({ select: (state) => state.status === "pending" });
  return (
    <div className="nav-progress" data-pending={pending ? "true" : "false"} aria-hidden="true" />
  );
}

/** Stands in for a view until its data arrives; the sidebar and header stay as they were. */
export function ViewPlaceholder() {
  return (
    <section className="view-placeholder grid gap-3.5 px-8 pt-2" aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <span className="block h-3.5 w-[42%] rounded-[4px] bg-rule" />
      <span className="block h-3.5 w-[78%] rounded-[4px] bg-rule" />
      <span className="block h-3.5 w-[64%] rounded-[4px] bg-rule" />
    </section>
  );
}
