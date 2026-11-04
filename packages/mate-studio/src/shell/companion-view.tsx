import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { StudioSearch } from "../lib/search";
import { companionViewQuery } from "../lib/studio-queries";
import type { CompanionView as View, CompanionViewData } from "../server/views";
import { CompanionError } from "./companion-error";

/** A companion view's data, or the companion's error in its place; the rest of the page stays. */
export function CompanionView({
  view,
  search,
  children,
}: {
  view: View;
  search: StudioSearch;
  children: (data: CompanionViewData) => ReactNode;
}) {
  const { data } = useSuspenseQuery(companionViewQuery(view, search));
  if (data.error)
    return <CompanionError companionPath={data.error.companionPath} reason={data.error.reason} />;
  return <>{children(data)}</>;
}
