import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { VaultView } from "@uniqbit/mate-core/studio";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { buttonVariants } from "../../components/ui/button-variants";
import { cn } from "../../lib/cn";
import { useMediaQuery } from "../../lib/use-media-query";
import { afterVaultFileChange, type VaultSearch } from "../../lib/studio-queries";
import { previewVaultFile, saveVaultFile } from "../../server/vault";
import { useVaultUi } from "../../stores/vault-ui";
import { MarkdownView } from "./markdown-view";

/** What the open file's stream reports: a new version, a removal, or an overwritten save. */
interface VaultWatchEvent {
  kind: "changed" | "removed" | "overwritten";
  content?: string;
  token?: string;
}

const eventsUrl = (companion: string, path: string) =>
  `/api/vault/events?${new URLSearchParams({ companion, path })}`;

/** Follows the open file on disk for as long as it is shown. */
function useFileEvents(companion: string, path: string, onEvent: (event: VaultWatchEvent) => void) {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(eventsUrl(companion, path));
    source.onmessage = (message) => {
      try {
        handler.current(JSON.parse(message.data) as VaultWatchEvent);
      } catch {
        /* a malformed event is skipped */
      }
    };
    return () => source.close();
  }, [companion, path]);
}

/** The document column's toolbar: where the file is, then its controls. Stays in view. */
export function VaultToolbar({ crumbs, children }: { crumbs: ReactNode; children?: ReactNode }) {
  return (
    <div className="vault-bar sticky top-0 z-2 flex min-h-[52px] items-center gap-2 border-b border-rule-soft bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-6 py-2 backdrop-blur-md max-sm:px-3">
      <div className="mr-auto flex min-w-0 items-center gap-1">{crumbs}</div>
      {children}
    </div>
  );
}

/** The centred reading column of a rendered file. */
const PROSE = "vault-prose prose mx-auto w-full max-w-[68ch] px-10 pt-10 pb-28 max-sm:px-4";

const MODE_LINK = buttonVariants({ variant: "default", size: "sm" });

function CopyPath({ path }: { path: string }) {
  return (
    <button
      type="button"
      className={buttonVariants({ variant: "ghost", size: "sm" })}
      data-copy={path}
      data-copy-label="path"
      aria-label="Copy path"
    >
      <Icon name="copy" className="size-3.5" />
      <span className="@max-[1000px]:hidden">Copy path</span>
    </button>
  );
}

/**
 * An open file, read rendered or edited raw. Without the write path a file is only ever read,
 * whatever the address names. Saving returns to read; leaving edit with unsaved text asks.
 */
export function VaultFile({
  companion,
  data,
  writable,
  search,
  crumbs,
}: {
  companion: string;
  data: VaultView;
  writable: boolean;
  search: VaultSearch;
  crumbs: ReactNode;
}) {
  const open = data.open;
  if (!open) {
    return (
      <>
        <VaultToolbar crumbs={crumbs} />
        <div className={PROSE}>
          <h1 className="text-xl">{data.refusal ? "File refused" : "Open a markdown file"}</h1>
          <p className={data.refusal ? "vault-warning text-warn" : "empty text-muted"}>
            {data.refusal ?? "Choose a file from the tree to begin."}
          </p>
        </div>
      </>
    );
  }
  const editing = writable && search.mode === "edit";
  return editing ? (
    <Editor key={`${open.path}:edit`} companion={companion} data={data} crumbs={crumbs} />
  ) : (
    <Reader
      key={`${open.path}:read`}
      companion={companion}
      data={data}
      writable={writable}
      crumbs={crumbs}
    />
  );
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** Rendered; a change on disk shows at once, a removal is stated. */
function Reader({
  companion,
  data,
  writable,
  crumbs,
}: {
  companion: string;
  data: VaultView;
  writable: boolean;
  crumbs: ReactNode;
}) {
  const open = data.open!;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  useFileEvents(companion, open.path, (event) => {
    if (event.kind === "removed") setStatus("this file no longer exists on disk");
    else void afterVaultFileChange(queryClient, companion);
  });
  return (
    <div data-vault-root data-vault-mode="read" data-vault-path={open.path}>
      <VaultToolbar crumbs={crumbs}>
        <CopyPath path={open.path} />
        {writable ? (
          <Link
            className={MODE_LINK}
            id="vault-mode-edit"
            to="/vault"
            search={(previous) => ({ ...previous, mode: "edit" as const })}
            data-vault-mode-link
          >
            <Icon name="pencil" className="size-3.5" />
            Edit
          </Link>
        ) : (
          <span className="text-xs text-muted" title="Start Studio with --writable to edit.">
            Read only
          </span>
        )}
      </VaultToolbar>
      <article className={PROSE} aria-label={fileName(open.path)}>
        <MarkdownView nodes={open.markdown} />
        <p id="vault-status" className="text-sm text-warn" aria-live="polite">
          {status}
        </p>
      </article>
    </div>
  );
}

/**
 * The editor's text rendered as it would be saved, a moment after typing stops. Unchanged text
 * reuses the opened file's rendering; a preview hidden by a narrow window asks for nothing.
 */
function Preview({
  companion,
  open,
  text,
}: {
  companion: string;
  open: NonNullable<VaultView["open"]>;
  text: string;
}) {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), 250);
    return () => clearTimeout(timer);
  }, [text]);
  // False while the server renders, so no query holds the stream open.
  const shown = useMediaQuery("(min-width: 64rem)");
  const unchanged = settled === open.content;
  const preview = useQuery({
    queryKey: ["vault-preview", companion, open.path, settled],
    queryFn: () => previewVaultFile({ data: { companion, path: open.path, content: settled } }),
    placeholderData: (previous) => previous,
    enabled: shown && !unchanged,
    gcTime: 0,
  });
  const nodes = unchanged ? open.markdown : preview.data;
  return (
    <div
      className="vault-preview min-h-0 overflow-auto max-lg:hidden"
      aria-label="Preview"
      role="region"
      data-vault-preview
    >
      <p className="m-0 px-7 pt-3 text-xs font-semibold text-muted">Preview</p>
      <div className="prose px-7 pt-2 pb-16 text-sm">
        {nodes ? <MarkdownView nodes={nodes} /> : null}
      </div>
    </div>
  );
}

/** The raw editor with an explicit save; unsaved text is never replaced by a version from disk. */
function Editor({
  companion,
  data,
  crumbs,
}: {
  companion: string;
  data: VaultView;
  crumbs: ReactNode;
}) {
  const open = data.open!;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState(open.content);
  const [original, setOriginal] = useState(open.content);
  const [token, setToken] = useState(open.token);
  const [status, setStatus] = useState("");
  const [incoming, setIncoming] = useState<{ content: string; token: string } | null>(null);
  const dirty = text !== original;
  // Read when leaving; a successful save clears it before navigating back to read.
  const unsaved = useRef(dirty);
  useEffect(() => {
    unsaved.current = dirty;
  }, [dirty]);
  const setDirty = useVaultUi((state) => state.setDirty);
  useEffect(() => setDirty(dirty), [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  useBlocker({
    shouldBlockFn: () => unsaved.current && !window.confirm("Discard unsaved changes?"),
    enableBeforeUnload: () => unsaved.current,
  });

  useFileEvents(companion, open.path, (event) => {
    if (event.kind === "removed") {
      setStatus("this file no longer exists on disk");
      return;
    }
    const version = { content: event.content ?? "", token: event.token ?? "" };
    if (event.kind === "overwritten") {
      setIncoming(version);
      setStatus("a version was overwritten; its content is available below");
    } else if (dirty) {
      setIncoming(version);
      setStatus("the file changed on disk; unsaved content is still in the editor");
    } else {
      setText(version.content);
      setOriginal(version.content);
      setToken(version.token);
      setStatus("updated from disk");
    }
  });

  const save = useMutation({
    mutationFn: () => saveVaultFile({ data: { companion, path: open.path, content: text, token } }),
    onSuccess: (result) => {
      if (result.kind === "conflict") {
        setIncoming({ content: result.content, token: result.token });
        setStatus(result.reason || "save refused");
        return;
      }
      setToken(result.token);
      setOriginal(text);
      unsaved.current = false;
      setDirty(false);
      setStatus("saved");
      // The rendered file refreshes in the background; read is shown at once.
      void afterVaultFileChange(queryClient, companion);
      // Back to read, showing the saved content, where the viewer was.
      void navigate({
        to: "/vault",
        search: (previous) => ({ ...previous, mode: undefined }),
        resetScroll: false,
      });
    },
    onError: (error) => setStatus(error.message || "save failed"),
  });

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-vault-root
      data-vault-mode="edit"
      data-vault-path={open.path}
    >
      <VaultToolbar crumbs={crumbs}>
        {dirty ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-warn">
            <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
            Unsaved
          </span>
        ) : null}
        <Link
          className={MODE_LINK}
          id="vault-mode-read"
          to="/vault"
          search={(previous) => ({ ...previous, mode: undefined })}
          data-vault-mode-link
        >
          <Icon name="eye" className="size-3.5" />
          Read
        </Link>
        <Button
          variant="primary"
          size="sm"
          id="vault-save"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </Button>
      </VaultToolbar>
      {/* Always mounted, so a screen reader announces the first status too. */}
      <div
        className={
          status || incoming
            ? "grid gap-2 border-b border-rule-soft px-6 py-2.5 text-sm"
            : "sr-only"
        }
      >
        <p id="vault-status" className="m-0 text-warn" aria-live="polite">
          {status}
        </p>
        {incoming ? (
          <div id="vault-incoming" className="grid gap-2">
            <strong id="vault-incoming-title" className="text-sm">
              Incoming version
            </strong>
            <pre
              id="vault-incoming-content"
              className="m-0 max-h-40 overflow-auto rounded-control border border-rule bg-surface p-3 font-mono text-xs whitespace-pre-wrap"
            >
              {incoming.content}
            </pre>
            <Button
              size="sm"
              id="vault-recover"
              className="justify-self-start"
              onClick={() => {
                setText(incoming.content);
                setOriginal(incoming.content);
                if (incoming.token) setToken(incoming.token);
                setIncoming(null);
                setStatus("incoming version loaded into the editor");
              }}
            >
              Put incoming content back
            </Button>
          </div>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-2 max-lg:grid-cols-1">
        <textarea
          id="vault-editor"
          data-vault-editor
          data-vault-path={open.path}
          aria-label={`Markdown source of ${fileName(open.path)}`}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className={cn(
            "min-h-[60vh] resize-none border-0 border-r border-rule-soft bg-transparent px-6 pt-4 pb-10 font-mono text-[0.86rem] leading-[1.75] text-text outline-none focus-visible:outline-none max-lg:border-r-0",
          )}
        />
        <Preview companion={companion} open={open} text={text} />
      </div>
    </div>
  );
}
