import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { getGuide } from "../server/guides";
import { GettingStarted } from "../views/getting-started/getting-started";

export const Route = createFileRoute("/getting-started/$topic")({
  loaderDeps: ({ search }) => search,
  ssr: true,
  loader: async ({ context, deps, params }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? getGuide({ data: { topic: params.topic } })
      : null,
  component: function TopicRoute() {
    return (
      <GettingStarted
        topic={Route.useParams().topic}
        guide={Route.useLoaderData()}
        search={Route.useSearch()}
      />
    );
  },
});
