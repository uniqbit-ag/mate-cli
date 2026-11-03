import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { factoryQuery } from "../lib/factory-query";
import { registeredCompanion, shellQuery } from "../lib/queries";
import { Factory } from "../views/factory/factory-view";

export const Route = createFileRoute("/factory")({
  staticData: { view: "factory" },
  validateSearch: (raw: { outcome?: unknown }) =>
    typeof raw.outcome === "string" && /^[a-z0-9][a-z0-9-]*$/.test(raw.outcome)
      ? { outcome: raw.outcome }
      : {},
  // Only offered where the factory broker runs; elsewhere the address lands on the Overview.
  beforeLoad: async ({ context, search }) => {
    const studioSearch = { companion: search.companion, studioMode: search.studioMode };
    const shell = await context.queryClient.ensureQueryData(shellQuery(studioSearch));
    if (!shell.factoryMode) throw redirect({ to: "/", search: studioSearch });
  },
  loaderDeps: ({ search }) => ({ companion: search.companion, studioMode: search.studioMode }),
  loader: async ({ context, deps }) => {
    const companion = await registeredCompanion(context.queryClient, deps);
    return companion ? context.queryClient.ensureQueryData(factoryQuery(companion)) : null;
  },
  component: FactoryRoute,
});

function FactoryRoute() {
  const { companion, outcome } = Route.useSearch();
  const navigate = useNavigate();
  // A link from before the move names the Outcome as `#outcome-<id>`, which never reaches the
  // server; it opens the same dialog.
  useEffect(() => {
    const legacy = /^#outcome-([a-z0-9][a-z0-9-]*)$/.exec(window.location.hash)?.[1];
    if (legacy && !outcome) {
      void navigate({
        to: "/factory",
        search: (previous) => ({ ...previous, outcome: legacy }),
        hash: "",
        replace: true,
      });
    }
  }, [navigate, outcome]);
  if (!companion) return null;
  return <FactoryBoard companion={companion} outcome={outcome} />;
}

function FactoryBoard({ companion, outcome }: { companion: string; outcome?: string }) {
  const { data } = useSuspenseQuery(factoryQuery(companion));
  if (!data.payload) {
    return (
      <section className="panel">
        <p className="empty">{data.error ?? "No state collected for this companion."}</p>
      </section>
    );
  }
  return (
    <Factory
      payload={data.payload}
      companionDigest={companion}
      writable={data.writable}
      factoryMode={data.factoryMode}
      sessions={data.sessions}
      runs={data.runs}
      now={data.renderedAt}
      openId={outcome}
    />
  );
}
