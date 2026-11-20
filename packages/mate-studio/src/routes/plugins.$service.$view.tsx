import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SERVICE_ROUTE_PREFIX } from "@uniqbit/mate-core/studio";

import { shellQuery } from "../lib/studio-queries";
import { PluginView } from "../plugins/plugin-view";

/** A view a plugin service ships as its own module; Studio mounts it in the layout. */
export const Route = createFileRoute("/plugins/$service/$view")({
  staticData: { pluginView: true },
  component: function PluginViewRoute() {
    const { service, view } = Route.useParams();
    const search = Route.useSearch();
    const { data: shell } = useSuspenseQuery(shellQuery(search));
    const found = shell.pluginViews.find(
      (entry) => entry.service === service && entry.view === view,
    );
    if (!found) {
      return (
        <section className="mx-8 max-sm:mx-4">
          <p className="empty m-0 rounded-card border border-dashed border-rule px-6 py-7 text-muted">
            No running service offers this view.
          </p>
        </section>
      );
    }
    return (
      <PluginView
        moduleUrl={found.moduleUrl}
        context={{
          companion: shell.selected?.digest ?? null,
          apiBase: `${SERVICE_ROUTE_PREFIX}${service}`,
          writable: shell.writable,
        }}
      />
    );
  },
});
