import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { SkillAgent } from "@uniqbit/mate-core/studio";
import { useState } from "react";

import { Icon } from "../../components/icon";
import { cn } from "../../lib/cn";
import { skillPreviewQuery } from "../../lib/studio-queries";
import { PanelSection } from "../../shell/panel";
import { MarkdownView } from "../vault/markdown-view";

const ITEM =
  "flex w-full min-w-0 items-center gap-2.5 rounded-control border-0 bg-transparent px-2 py-1 text-left text-sm text-text hover:bg-surface-soft aria-[current=true]:bg-accent-soft";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** The skill's files, read-only; SKILL.md opens first, any other file on choosing it. */
export function SkillFiles({
  companion,
  agent,
  name,
}: {
  companion: string;
  agent: SkillAgent;
  name: string;
}) {
  const [file, setFile] = useState<string | undefined>(undefined);
  // The file shown stays while the next one loads.
  const preview = useQuery({
    ...skillPreviewQuery(companion, agent, name, file),
    placeholderData: keepPreviousData,
  });
  // A failed refresh keeps the files already shown.
  if (!preview.data) {
    return (
      <PanelSection title="Files">
        {preview.isError ? (
          <p className="m-0 text-sm text-muted" role="alert">
            {preview.error instanceof Error
              ? preview.error.message
              : "The skill could not be read."}
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">Listing files…</p>
        )}
      </PanelSection>
    );
  }
  const { files, truncated, open } = preview.data;
  return (
    <>
      <PanelSection title="Files" aside={truncated ? `first ${files.length}` : files.length}>
        <ul className="m-0 -mx-2 grid list-none gap-0.5 p-0">
          {files.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={ITEM}
                aria-current={open?.path === entry.path ? "true" : undefined}
                data-skill-file={entry.path}
                onClick={() => setFile(entry.path)}
              >
                <Icon name="doc" className="flex-none text-muted" />
                <span className="min-w-0 truncate font-mono text-xs">{entry.path}</span>
                <span className="ml-auto flex-none font-mono text-2xs text-muted">
                  {sizeText(entry.size)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PanelSection>
      {open ? (
        <section
          className={cn("grid gap-2.5 px-5 py-4", preview.isPlaceholderData && "opacity-60")}
          aria-label={`File ${open.path}`}
        >
          <code className="truncate font-mono text-xs text-muted">{open.path}</code>
          {open.nodes ? (
            <div className="prose-panel">
              <MarkdownView nodes={open.nodes} />
            </div>
          ) : (
            <p className="m-0 text-sm text-muted">{open.note}</p>
          )}
        </section>
      ) : null}
    </>
  );
}
