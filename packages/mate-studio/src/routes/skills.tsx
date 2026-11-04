import { createFileRoute } from "@tanstack/react-router";

import { registeredCompanion } from "../lib/queries";
import { companionViewQuery } from "../lib/view-query";
import { CompanionView } from "../shell/companion-view";
import { Skills } from "../views/skills/skills-view";

export const Route = createFileRoute("/skills")({
  staticData: { view: "skills" },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) =>
    (await registeredCompanion(context.queryClient, deps))
      ? context.queryClient.ensureQueryData(companionViewQuery("skills", deps))
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
