import type { StudioView } from "@uniqbit/mate-core/studio";

import type { ShellData } from "../server/shell";
import { LocalTime } from "./local-time";
import { VIEW_TITLES } from "./views";

export function PageHeader({ shell, view }: { shell: ShellData; view: StudioView }) {
  if (!shell.selected) return null;
  return (
    <header className="page-header">
      <div className="page-heading">
        <h1>{VIEW_TITLES[view]}</h1>
      </div>
      <div className="page-context">
        <span className="page-context-label">Companion Repository</span>
        <code>{shell.selected.path}</code>
        <span className="snapshot-status">
          <span className="snapshot-dot" aria-hidden="true" />
          {shell.collectedAt === null ? (
            "No snapshot"
          ) : (
            <>
              Snapshot <LocalTime at={shell.collectedAt} />
            </>
          )}
        </span>
      </div>
    </header>
  );
}
