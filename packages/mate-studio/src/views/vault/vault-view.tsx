import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { VaultEntry, VaultView as VaultData } from "@uniqbit/mate-core/studio";
import { useEffect, useState, type ReactNode } from "react";

import { getVault, getVaultChildren, getVaultMatches } from "../../server/vault";
import { type VaultSearch, vaultQuery } from "./vault-query";
import { useVaultUi } from "../../stores/vault-ui";
import { VaultFile } from "./vault-file";

const segments = (relative: string) => relative.split("/").filter(Boolean);

function FolderIcon() {
  return <span className="vault-icon vault-icon-folder" aria-hidden="true" />;
}

function FileIcon() {
  return <span className="vault-icon vault-icon-file" aria-hidden="true" />;
}

/** A file entry is a link to the file's address; it opens in read. */
function FileLink({
  entry,
  current,
  label,
}: {
  entry: VaultEntry;
  current: boolean;
  label?: string;
}) {
  return (
    <Link
      to="/vault"
      search={(previous) => ({ ...previous, path: entry.path, dir: undefined, mode: undefined })}
      className="vault-file"
      data-vault-entry={entry.path}
      aria-current={current ? "page" : undefined}
    >
      <FileIcon />
      <span>{label ?? entry.name}</span>
    </Link>
  );
}

/** Opens a folder's listing; a breadcrumb step or a listing row. */
function FolderLink({
  dir,
  className,
  children,
}: {
  dir: string | null;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/vault"
      search={(previous) => ({
        ...previous,
        path: undefined,
        dir: dir ?? undefined,
        mode: undefined,
      })}
      className={className}
    >
      {children}
    </Link>
  );
}

function TreeEntry({
  entry,
  companion,
  search,
}: {
  entry: VaultEntry;
  companion: string;
  search: VaultSearch;
}) {
  if (entry.kind === "file") return <FileLink entry={entry} current={search.path === entry.path} />;
  return <TreeFolder entry={entry} companion={companion} search={search} />;
}

/** Collapsed unless on the open path; a collapsed folder asks for its entries when first opened. */
function TreeFolder({
  entry,
  companion,
  search,
}: {
  entry: VaultEntry;
  companion: string;
  search: VaultSearch;
}) {
  const [open, setOpen] = useState(entry.children !== undefined);
  const children = useQuery({
    queryKey: ["vault", companion, "children", entry.path],
    queryFn: () => getVaultChildren({ data: { companion, dir: entry.path } }),
    enabled: open && entry.children === undefined,
  });
  const entries = entry.children ?? children.data?.entries;
  return (
    <details
      className="vault-directory"
      open={open}
      data-vault-dir={entry.path}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-current={search.dir === entry.path ? "page" : undefined}>
        <span className="vault-chevron" aria-hidden="true" />
        <FolderIcon />
        <span>{entry.name}</span>
      </summary>
      <div className="vault-children">
        {open && entries
          ? entries.map((child) => (
              <TreeEntry key={child.path} entry={child} companion={companion} search={search} />
            ))
          : null}
        {children.error ? <p className="note vault-warning">{children.error.message}</p> : null}
      </div>
    </details>
  );
}

function TreeSlot({
  data,
  companion,
  search,
}: {
  data: VaultData;
  companion: string;
  search: VaultSearch;
}) {
  if (data.failure) {
    return (
      <div data-vault-slot="tree">
        <p className="note vault-warning">The files could not be listed: {data.failure}</p>
      </div>
    );
  }
  if (data.tree === null) {
    return (
      <div data-vault-slot="tree" aria-busy="true">
        <p className="empty">Listing files…</p>
      </div>
    );
  }
  return (
    <div data-vault-slot="tree" data-vault-generation={data.generation ?? undefined}>
      <TreeStaleNote data={data} />
      {data.tree.length === 0 ? (
        <p className="empty">This companion has no markdown files.</p>
      ) : (
        <nav className="vault-tree" aria-label="Markdown files">
          {data.tree.map((entry) => (
            <TreeEntry key={entry.path} entry={entry} companion={companion} search={search} />
          ))}
        </nav>
      )}
    </div>
  );
}

function TreeStaleNote({ data }: { data: VaultData }) {
  if (data.warning) {
    return <p className="note vault-warning">{data.warning}. The tree may be out of date.</p>;
  }
  if (data.watching) return null;
  return <p className="note vault-warning">The tree may be out of date.</p>;
}

/** Name matches over the whole listed tree, bounded by the server. */
function FilterResults({
  companion,
  query,
  search,
}: {
  companion: string;
  query: string;
  search: VaultSearch;
}) {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const matches = useQuery({
    queryKey: ["vault", companion, "matches", settled],
    queryFn: () => getVaultMatches({ data: { companion, query: settled } }),
    enabled: settled.trim().length > 0,
  });
  if (!matches.data) return null;
  const { shown, total } = matches.data;
  const more = total - shown.length;
  return (
    <div data-vault-filter-results>
      {shown.length === 0 ? (
        <p className="empty">No files match.</p>
      ) : (
        <nav className="vault-tree vault-results" aria-label="Matching files">
          {shown.map((entry) => (
            <FileLink
              key={entry.path}
              entry={entry}
              current={search.path === entry.path}
              label={entry.path}
            />
          ))}
        </nav>
      )}
      {more > 0 ? (
        <p className="note" data-vault-more>
          {more} more match{more === 1 ? "" : "es"}; refine the filter.
        </p>
      ) : null}
    </div>
  );
}

/** Built from the address alone, so it shows before the tree is listed. */
function Breadcrumb({ rootName, search }: { rootName: string; search: VaultSearch }) {
  const parts = segments(search.path ?? search.dir ?? "");
  return (
    <nav className="vault-breadcrumb" aria-label="Breadcrumb" data-vault-crumb>
      <ol>
        <li>
          {parts.length === 0 ? (
            <span aria-current="page">{rootName}</span>
          ) : (
            <FolderLink dir={null} className="vault-crumb">
              {rootName}
            </FolderLink>
          )}
        </li>
        {parts.map((name, index) => {
          const dir = parts.slice(0, index + 1).join("/");
          return (
            <li key={dir}>
              {index === parts.length - 1 ? (
                <span aria-current="page">{name}</span>
              ) : (
                <FolderLink dir={dir} className="vault-crumb">
                  {name}
                </FolderLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function findEntries(tree: VaultEntry[], dir: string): VaultEntry[] | null {
  let level: VaultEntry[] | undefined = tree;
  for (const name of segments(dir)) {
    const folder: VaultEntry | undefined = level?.find(
      (entry) => entry.kind === "directory" && entry.name === name,
    );
    if (!folder) return null;
    level = folder.children;
  }
  return level ?? null;
}

/** With no file open: the open folder's entries, folders first, and the way to its parent. */
function Listing({ data }: { data: VaultData }) {
  if (data.failure) {
    return (
      <div data-vault-slot="listing" className="panel vault-listing">
        <p className="note vault-warning">The files could not be listed: {data.failure}</p>
      </div>
    );
  }
  if (data.tree === null) {
    return (
      <div data-vault-slot="listing" className="panel vault-listing" aria-busy="true">
        <p className="empty">Listing files…</p>
      </div>
    );
  }
  const entries = (data.dir ? findEntries(data.tree, data.dir) : null) ?? data.tree;
  const parts = data.dir ? segments(data.dir) : [];
  return (
    <div data-vault-slot="listing" className="panel vault-listing">
      {data.dirMissing ? (
        <p className="note vault-warning">That folder is not in the tree; showing the root.</p>
      ) : null}
      {entries.length === 0 && parts.length === 0 ? (
        <p className="empty">This companion has no markdown files.</p>
      ) : (
        <ul className="vault-rows" aria-label="Folder contents">
          {parts.length > 0 ? (
            <li>
              <FolderLink
                dir={parts.length > 1 ? parts.slice(0, -1).join("/") : null}
                className="vault-row"
              >
                <FolderIcon />
                <span>..</span>
              </FolderLink>
            </li>
          ) : null}
          {entries.map((entry) => (
            <li key={entry.path}>
              {entry.kind === "directory" ? (
                <FolderLink dir={entry.path} className="vault-row">
                  <FolderIcon />
                  <span>{entry.name}</span>
                </FolderLink>
              ) : (
                <Link
                  to="/vault"
                  search={(previous) => ({
                    ...previous,
                    path: entry.path,
                    dir: undefined,
                    mode: undefined,
                  })}
                  className="vault-row"
                >
                  <FileIcon />
                  <span>{entry.name}</span>
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The vault: the companion as folders beside the content. The tree holds only the top level
 * and the open path; it fills in without the viewer acting when it was not listed yet.
 */
export function VaultLayout({
  companion,
  rootName,
  writable,
  search,
}: {
  companion: string;
  rootName: string;
  writable: boolean;
  search: VaultSearch;
}) {
  const queryClient = useQueryClient();
  const view = useQuery(vaultQuery(companion, search));
  // A tree not listed yet arrives without the viewer acting.
  const waited = useQuery({
    ...vaultQuery(companion, search, true),
    enabled: Boolean(view.data && view.data.tree === null && !view.data.failure),
  });
  const data = waited.data ?? view.data;
  const [filter, setFilter] = useState("");
  const latest = useVaultUi((state) => state.latestGeneration);
  const treeHidden = useVaultUi((state) => state.treeHidden);
  const toggleTree = useVaultUi((state) => state.toggleTree);
  const hydrate = useVaultUi((state) => state.hydrate);
  useEffect(hydrate, [hydrate]);
  const refresh = useMutation({
    mutationFn: () =>
      getVault({
        data: { companion, path: search.path, dir: search.dir, refresh: true, wait: true },
      }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(vaultQuery(companion, search).queryKey, fresh);
      void queryClient.invalidateQueries({ queryKey: ["vault", companion], exact: false });
    },
  });
  if (!data) return <p className="empty">Listing files…</p>;
  const stale = latest !== null && data.generation !== null && latest > data.generation;
  return (
    <section className="vault-layout" data-vault-layout>
      <aside className="panel vault-tree-panel" id="vault-tree-panel" aria-label="Files">
        <div className="vault-tree-head">
          <strong>Files</strong>
          <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh tree"}
          </button>
        </div>
        <p id="vault-stale" className="note vault-warning" role="status" hidden={!stale}>
          Files changed — refresh tree.
        </p>
        {refresh.error ? (
          <p className="note vault-warning" role="status">
            {refresh.error.message}
          </p>
        ) : null}
        <input
          type="search"
          id="vault-filter"
          className="vault-filter"
          placeholder="Go to file"
          aria-label="Go to file"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFilter("");
          }}
        />
        {filter.trim() ? (
          <FilterResults companion={companion} query={filter} search={search} />
        ) : (
          <TreeSlot data={data} companion={companion} search={search} />
        )}
      </aside>
      <div className="vault-main" data-vault-main>
        <div className="vault-bar">
          <button
            type="button"
            id="vault-tree-toggle"
            className="vault-tree-toggle"
            aria-controls="vault-tree-panel"
            aria-expanded={!treeHidden}
            onClick={toggleTree}
          >
            {treeHidden ? "Show files" : "Hide files"}
          </button>
          <Breadcrumb rootName={rootName} search={search} />
        </div>
        <div data-vault-pane>
          {search.path || data.open || data.refusal ? (
            <VaultFile companion={companion} data={data} writable={writable} search={search} />
          ) : (
            <Listing data={data} />
          )}
        </div>
      </div>
    </section>
  );
}
