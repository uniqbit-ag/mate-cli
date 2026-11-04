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
    <section className="view-placeholder" aria-busy="true">
      <span className="visually-hidden" role="status">
        Loading…
      </span>
      <span className="view-placeholder-line" />
      <span className="view-placeholder-line" />
      <span className="view-placeholder-line" />
    </section>
  );
}
