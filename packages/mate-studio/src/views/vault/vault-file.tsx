import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type { VaultView } from "@uniqbit/mate-core/studio";
import { useEffect, useRef, useState } from "react";

import { saveVaultFile } from "../../server/vault";
import { useVaultUi } from "../../stores/vault-ui";
import { MarkdownView } from "./markdown-view";
import type { VaultSearch } from "./vault-query";

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

/**
 * An open file, read rendered or edited raw. Without the write path a file is only ever read,
 * whatever the address names. Saving returns to read; leaving edit with unsaved text asks.
 */
export function VaultFile({
  companion,
  data,
  writable,
  search,
}: {
  companion: string;
  data: VaultView;
  writable: boolean;
  search: VaultSearch;
}) {
  const open = data.open;
  if (!open) {
    return (
      <div className="panel vault-editor-panel">
        <h3>{data.refusal ? "File refused" : "Open a markdown file"}</h3>
        <p className={data.refusal ? "note vault-warning" : "empty"}>
          {data.refusal ?? "Choose a file from the tree to begin."}
        </p>
      </div>
    );
  }
  const editing = writable && search.mode === "edit";
  return editing ? (
    <Editor key={`${open.path}:edit`} companion={companion} data={data} />
  ) : (
    <Reader key={`${open.path}:read`} companion={companion} data={data} writable={writable} />
  );
}

function Header({
  name,
  note,
  children,
}: {
  name: string;
  note: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <h3>{name}</h3>
        <p className="section-note">{note}</p>
      </div>
      <div className="vault-actions">{children}</div>
    </div>
  );
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** Rendered; a change on disk shows at once, a removal is stated. */
function Reader({
  companion,
  data,
  writable,
}: {
  companion: string;
  data: VaultView;
  writable: boolean;
}) {
  const open = data.open!;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  useFileEvents(companion, open.path, (event) => {
    if (event.kind === "removed") setStatus("this file no longer exists on disk");
    else void queryClient.invalidateQueries({ queryKey: ["vault", companion, "view"] });
  });
  return (
    <div
      className="panel vault-editor-panel"
      data-vault-root
      data-vault-mode="read"
      data-vault-path={open.path}
    >
      <Header
        name={fileName(open.path)}
        note={writable ? "Rendered view." : "Read-only mode. Start Studio with --writable to edit."}
      >
        {writable ? (
          <Link
            className="vault-mode-link"
            id="vault-mode-edit"
            to="/vault"
            search={(previous) => ({ ...previous, mode: "edit" as const })}
            data-vault-mode-link
          >
            Edit
          </Link>
        ) : null}
      </Header>
      <MarkdownView nodes={open.markdown} />
      <p id="vault-status" className="note" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

/** The raw editor with an explicit save; unsaved text is never replaced by a version from disk. */
function Editor({ companion, data }: { companion: string; data: VaultView }) {
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
      void queryClient.invalidateQueries({ queryKey: ["vault", companion, "view"] });
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
      className="panel vault-editor-panel"
      data-vault-root
      data-vault-mode="edit"
      data-vault-path={open.path}
    >
      <Header name={fileName(open.path)} note="Changes stay in the editor until you save.">
        <button
          type="button"
          id="vault-save"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </button>
        <Link
          className="vault-mode-link"
          id="vault-mode-read"
          to="/vault"
          search={(previous) => ({ ...previous, mode: undefined })}
          data-vault-mode-link
        >
          Read
        </Link>
      </Header>
      <textarea
        id="vault-editor"
        data-vault-editor
        data-vault-path={open.path}
        aria-label={`Markdown source of ${fileName(open.path)}`}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <p id="vault-status" className="note" aria-live="polite">
        {status}
      </p>
      {incoming ? (
        <div id="vault-incoming" className="vault-incoming">
          <strong id="vault-incoming-title">Incoming version</strong>
          <pre id="vault-incoming-content">{incoming.content}</pre>
          <button
            type="button"
            id="vault-recover"
            onClick={() => {
              setText(incoming.content);
              setOriginal(incoming.content);
              if (incoming.token) setToken(incoming.token);
              setIncoming(null);
              setStatus("incoming version loaded into the editor");
            }}
          >
            Put incoming content back
          </button>
        </div>
      ) : null}
    </div>
  );
}
