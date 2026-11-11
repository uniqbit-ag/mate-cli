import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { StudioChange } from "@uniqbit/mate-core/studio";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { vaultChildrenQuery, vaultQuery } from "../../lib/studio-queries";
import { MarkdownView } from "../vault/markdown-view";

const CHANGES_DIR = "openspec/changes";

const changeDir = (change: StudioChange): string => `${CHANGES_DIR}/${change.name}`;

const ITEM =
  "flex w-full min-w-0 items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-1 text-left text-sm text-text hover:bg-surface-soft disabled:cursor-default disabled:hover:bg-transparent";

function Check({ done }: { done: boolean }) {
  return (
    <span
      className={cn(
        "grid size-3.5 flex-none place-items-center rounded-[4px] border",
        done ? "border-accent bg-accent text-on-accent" : "border-rule bg-page",
      )}
      aria-hidden="true"
    >
      {done ? <Icon name="check" className="size-2.5 [stroke-width:2.4]" /> : null}
    </span>
  );
}

/** The change's spec deltas, one file per capability folder. */
function SpecFiles({
  companion,
  dir,
  onRead,
}: {
  companion: string;
  dir: string;
  onRead: (path: string) => void;
}) {
  const folders = useQuery(vaultChildrenQuery(companion, `${dir}/specs`));
  if (folders.isPending) return <p className="m-0 pl-8 text-xs text-muted">Listing specs…</p>;
  const specs = (folders.data?.entries ?? []).filter((entry) => entry.kind === "directory");
  if (folders.isError || specs.length === 0) {
    return (
      <p className="m-0 pl-8 text-xs text-muted">
        <Link to="/vault" search={(previous) => ({ ...previous, dir: `${dir}/specs` })}>
          Open the specs folder
        </Link>
      </p>
    );
  }
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-6">
      {specs.map((entry) => (
        <li key={entry.path}>
          <button
            type="button"
            className={ITEM}
            data-artifact-file={`${entry.path}/spec.md`}
            onClick={() => onRead(`${entry.path}/spec.md`)}
          >
            <Icon name="doc" className="flex-none text-muted" />
            <span className="truncate font-mono text-xs">{entry.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The artifacts the Delivery Path writes, in its order; a written one opens to read. */
export function Artifacts({
  change,
  companion,
  onRead,
}: {
  change: StudioChange;
  companion?: string;
  onRead: (path: string) => void;
}) {
  if (change.artifacts.length === 0)
    return <p className="m-0 text-sm text-muted">No artifacts yet.</p>;
  const dir = changeDir(change);
  return (
    <ul className="m-0 -mx-2 grid list-none gap-0.5 p-0">
      {change.artifacts.map((artifact) => {
        const done = artifact.status === "done";
        const readable = done && companion !== undefined;
        const folder = artifact.id === "specs";
        return (
          <li key={artifact.id}>
            <button
              type="button"
              className={ITEM}
              disabled={!readable || folder}
              data-artifact={artifact.id}
              onClick={() => onRead(`${dir}/${artifact.id}.md`)}
            >
              <Check done={done} />
              <span className={done ? "text-text" : "text-muted"}>{artifact.id}</span>
              <span className="ml-auto text-xs text-muted">
                {!done ? "not yet" : folder ? "per capability" : "read"}
              </span>
              {readable && !folder ? <Icon name="right" className="text-muted" /> : null}
            </button>
            {readable && folder ? (
              <SpecFiles companion={companion} dir={dir} onRead={onRead} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A companion markdown file, rendered; says so while it loads or cannot be read. */
export function ArtifactBody({ companion, path }: { companion: string; path: string }) {
  const file = useQuery(vaultQuery(companion, { path }));
  const markdown = file.data?.open?.markdown;
  return markdown ? (
    <div className="prose-panel">
      <MarkdownView nodes={markdown} />
    </div>
  ) : (
    <p className="m-0 text-sm text-muted">
      {file.isPending ? "Loading…" : "The file could not be read."}
    </p>
  );
}

/** One artifact read in the panel, so a review needs no trip to the Vault. */
export function ArtifactReader({
  companion,
  path,
  change,
  onBack,
}: {
  companion: string;
  path: string;
  change: StudioChange;
  onBack: () => void;
}) {
  const name = path.slice(changeDir(change).length + 1);
  return (
    <section className="grid content-start gap-3 px-5 py-4" aria-label={`Artifact ${name}`}>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="-ml-2" onClick={onBack}>
          <Icon name="left" /> Artifacts
        </Button>
        <code className="min-w-0 truncate font-mono text-xs text-muted">{name}</code>
        <Link
          className="ml-auto inline-flex flex-none items-center gap-1.5 text-xs"
          to="/vault"
          search={(previous) => ({ ...previous, path })}
        >
          <Icon name="external" className="size-3.5" /> Open in Vault
        </Link>
      </div>
      <ArtifactBody companion={companion} path={path} />
    </section>
  );
}
