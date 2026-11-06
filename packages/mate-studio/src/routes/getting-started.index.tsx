import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { getGuide } from "../server/guides";
import { GettingStarted } from "../views/getting-started/getting-started";

export const Route = createFileRoute("/getting-started/")({
  loaderDeps: ({ search }) => search,
  ssr: true,
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? getGuide({ data: { topic: "start" } })
      : null,
  component: function StartRoute() {
    return (
      <GettingStarted topic="start" guide={Route.useLoaderData()} search={Route.useSearch()} />
    );
  },
});
