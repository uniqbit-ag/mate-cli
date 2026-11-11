import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { Icon } from "../../components/icon";
import { vaultChildrenQuery } from "../../lib/studio-queries";
import { ArtifactBody } from "../overview/artifacts";

export type ChangeDocKind = "spec" | "tasks";

const TITLES: Record<ChangeDocKind, string> = { spec: "Spec", tasks: "Tasks" };

/** The change's spec deltas, one section per capability folder. */
function SpecDocs({ companion, dir }: { companion: string; dir: string }) {
  const folders = useQuery(vaultChildrenQuery(companion, `${dir}/specs`));
  if (folders.isPending) return <p className="m-0 text-sm text-muted">Loading…</p>;
  if (folders.isError) return <p className="m-0 text-sm text-muted">The spec could not be read.</p>;
  const specs = (folders.data?.entries ?? []).filter((entry) => entry.kind === "directory");
  if (specs.length === 0) {
    return <p className="m-0 text-sm text-muted">The change has no spec yet.</p>;
  }
  return (
    <>
      {specs.map((entry) => (
        <section key={entry.path} aria-label={`Spec ${entry.name}`}>
          {specs.length > 1 ? <h3 className="mono">{entry.name}</h3> : null}
          <ArtifactBody companion={companion} path={`${entry.path}/spec.md`} />
        </section>
      ))}
    </>
  );
}

/** A change's spec or task list in place of the Outcome's content, like a report; Back returns. */
export function ChangeDoc({
  companion,
  change,
  doc,
  onBack,
}: {
  companion: string;
  change: string;
  doc: ChangeDocKind;
  onBack: () => void;
}) {
  const dir = `openspec/changes/${change}`;
  // The opening button is hidden now; focus stays in the panel.
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => back.current?.focus(), []);
  return (
    <>
      <header className="outcome-dialog-head outcome-report-head">
        <button ref={back} type="button" className="outcome-report-back" onClick={onBack}>
          <Icon name="left" /> Back
        </button>
        <h2>
          {TITLES[doc]} · <span className="mono">{change}</span>
        </h2>
      </header>
      <div className="outcome-doc" data-outcome-doc={doc}>
        {doc === "spec" ? (
          <SpecDocs companion={companion} dir={dir} />
        ) : (
          <ArtifactBody companion={companion} path={`${dir}/tasks.md`} />
        )}
      </div>
    </>
  );
}
