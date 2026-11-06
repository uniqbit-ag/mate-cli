import { Link } from "@tanstack/react-router";

import type { StudioSearch } from "../../lib/search";
import type { Guide } from "../../server/guide-content";
import { MarkdownView } from "../vault/markdown-view";

const topics = [
  { id: "start", label: "Start here", path: "/getting-started" },
  { id: "worktrees", label: "Worktrees", path: "/getting-started/worktrees" },
  { id: "vscode", label: "VS Code & Cursor", path: "/getting-started/vscode" },
];

export function GettingStarted({
  topic,
  guide,
  search,
}: {
  topic: string;
  guide: Guide | null;
  search: StudioSearch;
}) {
  const selection = { companion: search.companion, studioMode: search.studioMode };
  return (
    <div className="guide-reader min-w-0 px-6 max-sm:px-4">
      <nav
        aria-label="Getting Started topics"
        className="mb-6 flex flex-wrap gap-2 border-b border-rule pb-3"
      >
        {topics.map(({ id, label, path }) => (
          <Link
            key={id}
            to={path}
            search={selection}
            activeOptions={{ exact: true }}
            aria-current={topic === id ? "page" : undefined}
            className="rounded-control px-3 py-2 text-sm text-muted hover:bg-surface hover:text-text aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent"
          >
            {label}
          </Link>
        ))}
      </nav>
      <article className="min-w-0 max-w-[70ch] pb-8" aria-label={guide?.title ?? "Guide not found"}>
        {guide && topic !== "start" ? (
          <h2 className="mb-4 text-lg font-semibold">{guide.title}</h2>
        ) : null}
        {guide ? (
          <MarkdownView nodes={guide.nodes} guideSearch={selection} />
        ) : (
          <>
            <h2 className="mb-2 text-lg font-semibold">Guide not found</h2>
            <p>
              This topic is not bundled with Studio.{" "}
              <Link to="/getting-started" search={selection} className="text-accent underline">
                Return to Start here
              </Link>
              .
            </p>
          </>
        )}
      </article>
    </div>
  );
}
