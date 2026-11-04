import { createFileRoute } from "@tanstack/react-router";

import { loadView, registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/studio-queries";
import { CompanionView } from "../shell/companion-view";
import { Skills } from "../views/skills/skills-view";

export const Route = createFileRoute("/skills")({
  staticData: { view: "skills" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? loadView(context.queryClient, companionViewQuery("skills", deps))
      : null,
  component: function SkillsRoute() {
    const search = Route.useSearch();
    return (
      <CompanionView view="skills" search={search}>
        {(data) => <Skills skills={data.skillInventory} />}
      </CompanionView>
    );
  },
});
