import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MdNode, VaultEntry, VaultView as VaultData } from "@uniqbit/mate-core/studio";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { ListCard, ROW } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import {
  afterVaultRefresh,
  vaultChildrenQuery,
  vaultMatchesQuery,
  type VaultSearch,
  vaultQuery,
} from "../../lib/studio-queries";
import { getVault } from "../../server/vault";
import { ViewPlaceholder } from "../../shell/navigation-progress";
import { useVaultUi } from "../../stores/vault-ui";
import { VaultFile, VaultToolbar } from "./vault-file";

const segments = (relative: string) => relative.split("/").filter(Boolean);

const TREE_ROW =
  "flex w-full min-w-0 items-center gap-2 rounded-[6px] border-0 bg-transparent px-2.5 py-1.5 text-left text-sm text-text no-underline hover:bg-surface aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold";

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
      className={cn(TREE_ROW, "vault-file")}
      data-vault-entry={entry.path}
      aria-current={current ? "page" : undefined}
    >
      <Icon name="doc" className={cn("size-3.5", current ? "text-accent" : "text-muted")} />
      <span className="min-w-0 flex-1 truncate">{label ?? entry.name}</span>
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
    ...vaultChildrenQuery(companion, entry.path),
    enabled: open && entry.children === undefined,
  });
  const entries = entry.children ?? children.data?.entries;
  return (
    <details
      className="vault-directory group/dir"
      open={open}
      data-vault-dir={entry.path}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className={cn(
          TREE_ROW,
          "cursor-pointer list-none font-semibold [&::-webkit-details-marker]:hidden",
        )}
        aria-current={search.dir === entry.path ? "page" : undefined}
      >
        <Icon
          name="right"
          className="size-3 text-muted transition-transform group-open/dir:rotate-90"
        />
        <Icon name="folder" className="size-3.5 text-muted" />
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      </summary>
      <div className="vault-children grid gap-px pl-3.5">
        {open && entries
          ? entries.map((child) => (
              <TreeEntry key={child.path} entry={child} companion={companion} search={search} />
            ))
          : null}
        {children.error ? (
          <p className="vault-warning m-0 px-2.5 py-1 text-xs text-warn">
            {children.error.message}
          </p>
        ) : null}
      </div>
    </details>
  );
}

const NOTE = "m-0 px-2.5 py-1.5 text-sm text-muted";
const WARNING = "vault-warning m-0 px-2.5 py-1.5 text-xs text-warn";

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
        <p className={WARNING}>The files could not be listed: {data.failure}</p>
      </div>
    );
  }
  if (data.tree === null) {
    return (
      <div data-vault-slot="tree" aria-busy="true">
        <p className={cn(NOTE, "empty")}>Listing files…</p>
      </div>
    );
  }
  return (
    <div data-vault-slot="tree" data-vault-generation={data.generation ?? undefined}>
      <TreeStaleNote data={data} />
      {data.tree.length === 0 ? (
        <p className={cn(NOTE, "empty")}>This companion has no markdown files.</p>
      ) : (
        <nav className="vault-tree grid gap-px" aria-label="Markdown files">
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
    return <p className={WARNING}>{data.warning}. The tree may be out of date.</p>;
  }
  if (data.watching) return null;
  return <p className={WARNING}>The tree may be out of date.</p>;
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
    ...vaultMatchesQuery(companion, settled),
    enabled: settled.trim().length > 0,
  });
  if (!matches.data) return null;
  const { shown, total } = matches.data;
  const more = total - shown.length;
  return (
    <div data-vault-filter-results>
      {shown.length === 0 ? (
        <p className={cn(NOTE, "empty")}>No files match.</p>
      ) : (
        <nav className="vault-tree vault-results grid gap-px" aria-label="Matching files">
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
        <p className={NOTE} data-vault-more>
          {more} more match{more === 1 ? "" : "es"}; refine the filter.
        </p>
      ) : null}
    </div>
  );
}

const CRUMB =
  "vault-crumb rounded-[6px] px-1.5 py-0.5 text-sm text-muted no-underline hover:bg-surface hover:text-text";

/** Built from the address alone, so it shows before the tree is listed. */
function Breadcrumb({ rootName, search }: { rootName: string; search: VaultSearch }) {
  const parts = segments(search.path ?? search.dir ?? "");
  return (
    <nav className="vault-breadcrumb min-w-0" aria-label="Breadcrumb" data-vault-crumb>
      <ol className="m-0 flex min-w-0 list-none items-center gap-0.5 overflow-hidden p-0 text-sm text-muted">
        <li className="flex-none">
          {parts.length === 0 ? (
            <span aria-current="page" className="px-1.5 font-semibold text-text">
              {rootName}
            </span>
          ) : (
            <FolderLink dir={null} className={CRUMB}>
              {rootName}
            </FolderLink>
          )}
        </li>
        {parts.map((name, index) => {
          const dir = parts.slice(0, index + 1).join("/");
          const last = index === parts.length - 1;
          return (
            <li
              key={dir}
              className={cn(
                "flex items-center gap-0.5",
                last ? "min-w-0" : "flex-none max-md:hidden",
              )}
            >
              <span aria-hidden="true">/</span>
              {last ? (
                <span aria-current="page" className="truncate px-1.5 font-semibold text-text">
                  {name}
                </span>
              ) : (
                <FolderLink dir={dir} className={CRUMB}>
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

/** With no file open: the open folder's entries as a list card, folders first. */
function Listing({ data, rootName }: { data: VaultData; rootName: string }) {
  const body = (() => {
    if (data.failure)
      return <p className={WARNING}>The files could not be listed: {data.failure}</p>;
    if (data.tree === null) return <p className={cn(NOTE, "empty")}>Listing files…</p>;
    return null;
  })();
  const parts = data.dir ? segments(data.dir) : [];
  const title = parts.at(-1) ?? rootName;
  if (body) {
    return (
      <div
        data-vault-slot="listing"
        className="vault-listing mx-auto w-full max-w-[820px] px-10 py-8"
        aria-busy={data.tree === null}
      >
        {body}
      </div>
    );
  }
  const entries = (data.dir ? findEntries(data.tree!, data.dir) : null) ?? data.tree!;
  return (
    <div
      data-vault-slot="listing"
      className="vault-listing mx-auto grid w-full max-w-[820px] gap-4 px-10 py-8 max-sm:px-4"
    >
      <h1 className="m-0 text-xl font-semibold">{title}</h1>
      {data.dirMissing ? (
        <p className={WARNING}>That folder is not in the tree; showing the root.</p>
      ) : null}
      {entries.length === 0 && parts.length === 0 ? (
        <p className={cn(NOTE, "empty")}>This companion has no markdown files.</p>
      ) : (
        <ListCard title="In this folder" count={entries.length}>
          <ul className="vault-rows m-0 list-none p-0" aria-label="Folder contents">
            {parts.length > 0 ? (
              <li>
                <FolderLink
                  dir={parts.length > 1 ? parts.slice(0, -1).join("/") : null}
                  className={cn(ROW, "vault-row py-1.5")}
                >
                  <Icon name="left" className="text-muted" />
                  <span>..</span>
                </FolderLink>
              </li>
            ) : null}
            {entries.map((entry) => (
              <li key={entry.path}>
                {entry.kind === "directory" ? (
                  <FolderLink
                    dir={entry.path}
                    className={cn(ROW, "vault-row py-1.5 font-semibold")}
                  >
                    <Icon name="folder" className="text-muted" />
                    <span className="truncate">{entry.name}</span>
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
                    className={cn(ROW, "vault-row py-1.5")}
                  >
                    <Icon name="doc" className="text-muted" />
                    <span className="truncate">{entry.name}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </ListCard>
      )}
    </div>
  );
}

interface Heading {
  index: number;
  text: string;
}

/** The plain text of a rendered markdown node. */
function textOf(node: MdNode): string {
  return typeof node === "string" ? node : (node.c ?? []).map(textOf).join("");
}

/** The open file's second-level headings, in document order. */
function headingsOf(markdown: MdNode[] | undefined): Heading[] {
  return (markdown ?? [])
    .filter((node): node is Exclude<MdNode, string> => typeof node !== "string" && node.t === "h2")
    .map((node, index) => ({ index, text: textOf(node) }));
}

const headingElements = (root: HTMLElement | null) => [
  ...(root?.querySelectorAll<HTMLElement>("article .markdown-body h2") ?? []),
];

/** Which heading is in view, followed as the document scrolls; the first until then. */
function useCurrentHeading(
  scroller: RefObject<HTMLDivElement | null>,
  markdown: MdNode[] | undefined,
  count: number,
) {
  const [current, setCurrent] = useState<number | null>(null);
  // Follows the rendered file: a new file, or a new version of it, is observed afresh.
  useEffect(() => {
    if (!markdown) return;
    const root = scroller.current;
    const elements = headingElements(root);
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setCurrent(elements.indexOf(visible.target as HTMLElement));
      },
      { root, rootMargin: "-60px 0px -70% 0px" },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, markdown]);
  const go = (index: number) => {
    headingElements(scroller.current)[index]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setCurrent(index);
  };
  return { current: current !== null && current < count ? current : 0, go };
}

function Outline({
  headings,
  current,
  go,
}: {
  headings: Heading[];
  current: number;
  go: (index: number) => void;
}) {
  return (
    <nav
      className="vault-outline min-h-0 overflow-auto border-l border-rule-soft px-5 pt-[72px] pb-6 @max-[1080px]:hidden"
      aria-label="Outline"
    >
      <h2 className="m-0 mb-2 text-xs font-semibold text-muted">On this page</h2>
      <ol className="m-0 grid list-none gap-0.5 p-0">
        {headings.map((heading) => (
          <li key={heading.index}>
            <button
              type="button"
              className={cn(
                "block w-full truncate rounded-r-[8px] border-0 bg-transparent px-2.5 py-1 text-left text-sm text-text hover:bg-surface",
                current === heading.index &&
                  "font-semibold text-accent shadow-[inset_2px_0_0_var(--accent)]",
              )}
              aria-current={current === heading.index ? "location" : undefined}
              onClick={() => go(heading.index)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const NO_HEADINGS: Heading[] = [];

const columns = (tree: boolean, outline: boolean): string =>
  [tree ? "272px" : null, "minmax(0,1fr)", outline ? "232px" : null].filter(Boolean).join(" ");

/** The tree column: refresh, the stale notice, the name filter and the tree or its matches. */
function FilesPanel({
  data,
  companion,
  search,
  stale,
  refresh,
  filter,
  setFilter,
  hidden,
}: {
  data: VaultData;
  companion: string;
  search: VaultSearch;
  stale: boolean;
  refresh: { isPending: boolean; error: Error | null; mutate: () => void };
  /** Held by the layout, so hiding and showing the tree keeps it. */
  filter: string;
  setFilter: (filter: string) => void;
  /** Hidden, not unmounted, so open folders survive; the prepaint attribute hides it first. */
  hidden: boolean;
}) {
  return (
    <aside
      hidden={hidden}
      className="vault-tree-panel flex min-h-0 flex-col border-r border-rule @max-[720px]:max-h-[40vh] @max-[720px]:border-r-0 @max-[720px]:border-b"
      id="vault-tree-panel"
      aria-label="Files"
    >
      <div className="flex items-center justify-between pt-3 pr-2.5 pb-2 pl-5">
        <strong className="text-sm">Files</strong>
        <Tooltip label="Refresh tree" side="bottom">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={refresh.isPending ? "Refreshing…" : "Refresh tree"}
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <Icon name="refresh" className={refresh.isPending ? "animate-spin" : undefined} />
          </Button>
        </Tooltip>
      </div>
      <p id="vault-stale" className={WARNING + " mx-2.5"} role="status" hidden={!stale}>
        Files changed — refresh tree.
      </p>
      {refresh.error ? (
        <p className={WARNING + " mx-2.5"} role="status">
          {refresh.error.message}
        </p>
      ) : null}
      <label className="mx-3.5 mb-2 flex h-[34px] items-center gap-2 rounded-control border border-rule bg-surface pr-2 pl-2.5 text-muted focus-within:border-accent">
        <Icon name="search" className="size-3.5" />
        <input
          type="search"
          id="vault-filter"
          className="vault-filter min-w-0 flex-1 border-0 bg-transparent text-sm text-text outline-none placeholder:text-muted"
          placeholder="Go to file"
          aria-label="Go to file"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setFilter("");
          }}
        />
      </label>
      <div className="min-h-0 flex-1 overflow-auto px-2.5 pb-6">
        {filter.trim() ? (
          <FilterResults companion={companion} query={filter} search={search} />
        ) : (
          <TreeSlot data={data} companion={companion} search={search} />
        )}
      </div>
    </aside>
  );
}

/**
 * The vault: a full-height workspace of tree, document and outline, each scrolling on its own.
 * The tree holds only the top level and the open path; it fills in when it was not listed yet.
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
    onSuccess: (fresh) => void afterVaultRefresh(queryClient, companion, search, fresh),
  });
  const scroller = useRef<HTMLDivElement>(null);
  const reading = Boolean(data?.open) && search.mode !== "edit";
  const headings = reading ? headingsOf(data?.open?.markdown) : NO_HEADINGS;
  const outline = useCurrentHeading(
    scroller,
    reading ? data?.open?.markdown : undefined,
    headings.length,
  );
  // The shared placeholder also shows the navigation progress bar.
  if (!data) return <ViewPlaceholder />;
  const stale = latest !== null && data.generation !== null && latest > data.generation;
  const showOutline = headings.length > 0;
  const crumbs = (
    <>
      <Tooltip label={treeHidden ? "Show files" : "Hide files"} side="bottom">
        <Button
          size="icon-sm"
          variant="ghost"
          id="vault-tree-toggle"
          aria-controls="vault-tree-panel"
          aria-expanded={!treeHidden}
          aria-label={treeHidden ? "Show files" : "Hide files"}
          onClick={toggleTree}
        >
          <Icon name="sidebar" />
        </Button>
      </Tooltip>
      <Breadcrumb rootName={rootName} search={search} />
    </>
  );
  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <section
        className="vault-layout grid min-h-0 flex-1 border-t border-rule @max-[720px]:grid-cols-1!"
        style={
          {
            "--vault-wide": columns(true, showOutline),
            "--vault-wide-bare": columns(false, showOutline),
            "--vault-narrow": columns(true, false),
            "--vault-narrow-bare": columns(false, false),
          } as CSSProperties
        }
        data-vault-layout
      >
        <FilesPanel
          data={data}
          companion={companion}
          search={search}
          stale={stale}
          refresh={refresh}
          filter={filter}
          setFilter={setFilter}
          hidden={treeHidden}
        />
        <div
          ref={scroller}
          className="vault-main min-h-0 min-w-0 overflow-auto scroll-smooth"
          data-vault-main
          data-vault-pane
        >
          {search.path || data.open || data.refusal ? (
            <VaultFile
              companion={companion}
              data={data}
              writable={writable}
              search={search}
              crumbs={crumbs}
            />
          ) : (
            <>
              <VaultToolbar crumbs={crumbs} />
              <Listing data={data} rootName={rootName} />
            </>
          )}
        </div>
        {showOutline ? <Outline headings={headings} {...outline} /> : null}
      </section>
    </div>
  );
}
