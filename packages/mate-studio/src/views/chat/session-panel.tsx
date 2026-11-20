import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { StickToBottomInstance } from "use-stick-to-bottom";

import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { chatCredentialQuery, chatCredentialText } from "../../lib/chat-credential";
import { chatSessionQuery } from "../../lib/chat-session";
import { cn } from "../../lib/cn";
import { useChatUi } from "../../stores/chat-ui";
import { oneLine, questionAnchor } from "./chat-text";

export interface PanelQuestion {
  id: string;
  text: string;
  /** The question's place among the conversation's messages, which its restore cuts at. */
  index: number;
}

const SHOWN_CHARS = 90;
const BOX = "rounded-card border border-rule bg-surface";

/** One group of names; an empty group says it has none. */
function Names({ title, names }: { title: string; names: readonly string[] }) {
  return (
    <div className="grid gap-1.5 px-3 py-2.5" data-chat-session-group={title}>
      <h3 className="m-0 text-2xs font-semibold tracking-wider text-muted uppercase">{title}</h3>
      {names.length === 0 ? (
        <p className="m-0 text-[0.82rem] text-muted">None loaded</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {names.map((name) => (
            <li
              key={name}
              className="rounded-full border border-rule bg-page px-2 py-0.5 font-mono text-2xs"
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Which credential answers; the panel's header button sets one. */
function CredentialSection() {
  const status = useQuery(chatCredentialQuery());
  return (
    <section
      aria-labelledby="chat-credential-title"
      className={cn(BOX, "grid shrink-0 gap-1.5 px-3 py-2.5")}
      data-chat-credential
    >
      <h3
        className="m-0 text-2xs font-semibold tracking-wider text-muted uppercase"
        id="chat-credential-title"
      >
        Credential
      </h3>
      <p
        className={cn("m-0 text-[0.82rem]", status.isError ? "text-bad" : "text-muted")}
        data-chat-credential-status
        role={status.isError ? "alert" : undefined}
      >
        {status.isError
          ? `The credential could not be read: ${status.error.message}`
          : chatCredentialText(status.data)}
      </p>
    </section>
  );
}

/** The MCP servers and Claude Code plugins a turn loads. */
function SessionSection({ companion }: { companion: string }) {
  const session = useQuery(chatSessionQuery(companion));
  return (
    <section
      aria-label="What the chat loads"
      className={cn(BOX, "shrink-0 divide-y divide-rule-soft")}
      data-chat-session
    >
      {session.data ? (
        <>
          <Names title="MCP servers" names={session.data.mcpServers} />
          <Names title="Plugins" names={session.data.plugins} />
        </>
      ) : (
        <p
          className={cn(
            "m-0 px-3 py-2.5 text-[0.82rem]",
            session.isError ? "text-bad" : "text-muted",
          )}
          role={session.isError ? "alert" : undefined}
        >
          {session.isError
            ? `What the chat loads could not be read: ${session.error.message}`
            : "Reading what the chat loads…"}
        </p>
      )}
    </section>
  );
}

/**
 * The conversation's questions as a timeline in its own scrolling box: a dot on a rail per
 * question, the one being read marked and kept in view; each scrolls to its question or
 * restores it.
 */
function QuestionIndex({
  questions,
  busy,
  onRestore,
  scroll,
}: {
  questions: PanelQuestion[];
  busy: boolean;
  onRestore: (index: number) => void;
  scroll: Pick<StickToBottomInstance, "scrollRef" | "stopScroll">;
}) {
  const { scrollRef, stopScroll } = scroll;
  const list = useRef<HTMLOListElement>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const ids = questions.map((question) => question.id).join(" ");
  // Before the reader scrolls, the newest question is the one in view.
  const reading = current ?? questions.at(-1)?.id;

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !ids) return;
    // The question being read is the last one that starts above the upper third of the view.
    const order = ids.split(" ");
    const update = () => {
      const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let found = order[0]!;
      for (const id of order) {
        const anchor = document.getElementById(questionAnchor(id));
        if (!anchor || anchor.getBoundingClientRect().top > line) break;
        found = id;
      }
      setCurrent(found);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [scrollRef, ids]);

  // The marked entry stays visible in the index's own box, without moving anything else.
  useEffect(() => {
    const box = list.current;
    const row = reading ? box?.querySelector(`[data-chat-question-row="${reading}"]`) : null;
    if (!box || !row) return;
    const outer = box.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
    else if (inner.bottom > outer.bottom) box.scrollTop += inner.bottom - outer.bottom;
  }, [reading]);

  if (questions.length === 0) return null;
  const go = (id: string) => {
    // Leave the newest answer, so the conversation does not pull back to the bottom.
    stopScroll();
    document
      .getElementById(questionAnchor(id))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const last = questions.length - 1;

  return (
    <nav
      aria-label="Jump to a question"
      className={cn(BOX, "flex min-h-0 flex-col overflow-hidden")}
      data-chat-questions
    >
      <ol ref={list} className="m-0 min-h-0 list-none overflow-y-auto overscroll-contain p-1.5">
        {questions.map((question, position) => {
          const marked = question.id === reading;
          const label = oneLine(question.text, SHOWN_CHARS);
          return (
            <li
              key={question.id}
              data-chat-question-row={question.id}
              className="group/question relative flex items-center rounded-control pl-5 transition-colors duration-150 ease-out hover:bg-page"
            >
              {questions.length > 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-[11px] w-px bg-rule",
                    position === 0 && "top-1/2 bottom-0",
                    position === last && "top-0 bottom-1/2",
                    position !== 0 && position !== last && "inset-y-0",
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 left-2 size-[7px] -translate-y-1/2 rounded-full ring-2 ring-surface transition-colors duration-150 ease-out group-hover/question:ring-page",
                  marked ? "bg-accent" : "bg-muted/60 group-hover/question:bg-text",
                )}
              />
              <button
                aria-current={marked ? "true" : undefined}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-control py-1.5 pr-1 pl-1.5 text-left text-[0.82rem] transition-colors duration-150 ease-out",
                  marked ? "font-medium text-text" : "text-muted group-hover/question:text-text",
                )}
                data-chat-question
                onClick={() => go(question.id)}
                title={label}
                type="button"
              >
                {label}
              </button>
              <Tooltip label="Edit this question and ask again from here" side="left">
                <Button
                  aria-label={`Edit “${label}” and ask again from here`}
                  className="mr-0.5 shrink-0 opacity-0 group-hover/question:opacity-100 focus-visible:opacity-100"
                  data-chat-question-restore
                  disabled={busy}
                  onClick={() => onRestore(question.index)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Icon name="undo" className="size-3.5" />
                </Button>
              </Tooltip>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The panel at the chat's right edge on wide screens: the credential that answers, the MCP
 * servers and plugins a turn loads, and an index of the conversation's questions. Collapsing it is remembered in the
 * browser.
 */
export function SessionPanel({
  companion,
  ...questionIndex
}: { companion: string } & Parameters<typeof QuestionIndex>[0]) {
  const open = useChatUi((state) => state.panelOpen);
  const setOpen = useChatUi((state) => state.setPanelOpen);
  const openCredential = useChatUi((state) => state.setCredentialOpen);
  const toggleLabel = open ? "Hide the session panel" : "Show the session panel";
  return (
    <aside
      aria-label="Chat session"
      className={cn(
        "hidden min-h-0 shrink-0 flex-col gap-2 pt-3 xl:flex",
        open ? "w-72" : "w-8 items-center",
      )}
      data-chat-panel={open ? "open" : "closed"}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 pl-1",
          open ? "h-7" : "flex-col-reverse gap-2",
        )}
      >
        {open ? <h2 className="m-0 mr-auto text-sm font-semibold">Session</h2> : null}
        <Tooltip label="Set the Claude credential chat answers with" side="left">
          <Button
            aria-haspopup="dialog"
            aria-label="Chat credential"
            data-open-chat-credential
            onClick={() => openCredential(true)}
            size={open ? "sm" : "icon-sm"}
            variant="ghost"
          >
            <Icon name="key" className="size-3.5" />
            {open ? "Credential" : null}
          </Button>
        </Tooltip>
        <Tooltip label={toggleLabel} side="left">
          <Button
            aria-controls="chat-panel-body"
            aria-expanded={open}
            aria-label={toggleLabel}
            data-chat-panel-toggle
            onClick={() => setOpen(!open)}
            size="icon-sm"
            variant="ghost"
          >
            <Icon name="sidebar" className="size-3.5" />
          </Button>
        </Tooltip>
      </div>
      {open ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3" id="chat-panel-body">
          <CredentialSection />
          <SessionSection companion={companion} />
          <QuestionIndex {...questionIndex} />
        </div>
      ) : null}
    </aside>
  );
}
