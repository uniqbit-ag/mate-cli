import { useChat } from "@ai-sdk/react";
import { Link } from "@tanstack/react-router";
import {
  CHAT_HISTORY_BUDGET,
  CHAT_MODELS,
  CHAT_ROUTE,
  type ChatEffort,
  type ChatModel,
  chatModel,
  isCredentialFailure,
  messageText,
  replayedChars,
} from "@uniqbit/mate-core/studio";
import { DefaultChatTransport, getToolName, isToolUIPart, type UIMessage } from "ai";
import { type ReactNode, useRef, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";

import { Checkpoint } from "../../components/ai-elements/checkpoint";
import { Context } from "../../components/ai-elements/context";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../../components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "../../components/ai-elements/message";
import { ModelSelector, type ModelOption } from "../../components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputHint,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "../../components/ai-elements/prompt-input";
import { Queue, type QueuedQuestion } from "../../components/ai-elements/queue";
import { Reasoning } from "../../components/ai-elements/reasoning";
import {
  CITATION_LINK,
  CitationProvider,
  Source,
  SOURCE_LINK,
  Sources,
} from "../../components/ai-elements/sources";
import { Suggestion, Suggestions } from "../../components/ai-elements/suggestion";
import {
  Tool,
  ToolBatch,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  ToolSteps,
} from "../../components/ai-elements/tool";
import { stepFailed, type ToolPart } from "../../components/ai-elements/tool-state";
import { Icon } from "../../components/icon";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { Tooltip } from "../../components/ui/tooltip";
import { PAGE_PAD } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { useChatUi } from "../../stores/chat-ui";
import { copyText } from "../../stores/page-ui";
import {
  batchLabel,
  CHAT_SUGGESTIONS,
  companionFile,
  failureText,
  questionAnchor,
  readFiles,
  runsOf,
  sentMessages,
  stepSummary,
  toolTarget,
} from "./chat-text";
import { SessionPanel } from "./session-panel";

/** Claude Code runs every turn on the login or key Studio's machine has; these are its models by alias. */
const PROVIDER = "Claude Code";
const NO_ROOTS: readonly string[] = [];
const MODEL_OPTIONS: ModelOption<ChatModel>[] = CHAT_MODELS["claude-code"].map(
  ({ id, name, description }) => ({ value: id, name, description }),
);
/** The model takes no effort setting. */
const effortless = (model: ChatModel) => chatModel("claude-code", model)?.effortless === true;
const EFFORT_OPTIONS: ModelOption<ChatEffort>[] = [
  { value: "low", name: "Low", description: "Answers sooner, thinks less" },
  { value: "medium", name: "Medium", description: "The usual balance" },
  { value: "high", name: "High", description: "Thinks longest before answering" },
];

/** Opens a companion file in the Vault, keeping the companion and mode. */
function VaultLink({
  file,
  className,
  children,
}: {
  file: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      className={className}
      search={(previous) => ({
        companion: previous.companion,
        studioMode: previous.studioMode,
        path: file,
      })}
      title={`Open ${file} in the Vault`}
      to="/vault"
    >
      {children}
    </Link>
  );
}

function ToolStep({
  part,
  stopped,
  roots,
}: {
  part: ToolPart;
  stopped: boolean;
  roots: readonly string[];
}) {
  const target = toolTarget(part.input);
  return (
    <Tool data-chat-tool={getToolName(part)}>
      <ToolHeader
        name={getToolName(part)}
        // A path inside the companion is shown from its root, as the Vault names it.
        target={companionFile(target, roots) ?? target}
        state={part.state}
        stopped={stopped}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        <ToolOutput
          output={"output" in part ? part.output : undefined}
          errorText={"errorText" in part ? part.errorText : undefined}
        />
      </ToolContent>
    </Tool>
  );
}

/** A run of more rows than this folds into one line once the answer moves past it. */
const OPEN_STEPS = 3;

const failedStep = (part: ToolPart) => stepFailed(part.state);
const unfinishedStep = (part: ToolPart) =>
  part.state === "input-streaming" || part.state === "input-available";

/** Consecutive steps of one tool: one row, or one batch row when there are several. */
function StepRun({
  run,
  stopped,
  roots,
}: {
  run: ToolPart[];
  stopped: boolean;
  roots: readonly string[];
}) {
  const steps = run.map((part) => (
    <ToolStep key={part.toolCallId} part={part} roots={roots} stopped={stopped} />
  ));
  if (run.length === 1) return steps[0];
  const name = getToolName(run[0]!);
  const targets = run.map((part) => {
    const target = toolTarget(part.input);
    const shown = companionFile(target, roots) ?? target;
    // A read names its file, which its last segment says best.
    return name === "read" ? (shown.split("/").at(-1) ?? shown) : shown;
  });
  return (
    <ToolBatch
      failed={run.filter(failedStep).length}
      label={batchLabel(name, run.length)}
      name={name}
      running={!stopped && run.some(unfinishedStep)}
      targets={targets}
    >
      {steps}
    </ToolBatch>
  );
}

/** The message's parts in order, each run of tool steps as one list. */
function messageBody(
  message: UIMessage,
  streaming: boolean,
  roots: readonly string[],
): ReactNode[] {
  const body: ReactNode[] = [];
  let steps: ToolPart[] = [];
  const closeSteps = (passed: boolean) => {
    if (steps.length === 0) return;
    const runs = runsOf(steps, getToolName);
    const folded = passed && runs.length > OPEN_STEPS;
    const summary = stepSummary(
      steps.map((part) => ({ name: getToolName(part), failed: failedStep(part) })),
    );
    const first = message.parts.indexOf(steps[0]!);
    body.push(
      <ToolSteps
        key={`${message.id}-steps-${first}`}
        summary={folded ? summary : undefined}
        failed={steps.some(failedStep)}
      >
        {runs.map((run) => (
          <StepRun key={run[0]!.toolCallId} roots={roots} run={run} stopped={!streaming} />
        ))}
      </ToolSteps>,
    );
    steps = [];
  };
  const last = message.parts.length - 1;
  message.parts.forEach((part, index) => {
    const key = `${message.id}-${index}`;
    if (isToolUIPart(part)) {
      steps.push(part);
      return;
    }
    if (part.type === "reasoning") {
      const thinking = streaming && index === last;
      if (!part.text.trim() && !thinking) return;
      closeSteps(true);
      body.push(<Reasoning key={key} streaming={thinking} text={part.text} />);
      return;
    }
    if (part.type !== "text") return;
    closeSteps(true);
    body.push(
      message.role === "user" ? (
        <p key={key} className="m-0 whitespace-pre-wrap">
          {part.text}
        </p>
      ) : (
        <MessageResponse key={key} isAnimating={streaming}>
          {part.text}
        </MessageResponse>
      ),
    );
  });
  closeSteps(!streaming);
  return body;
}

function AnswerMessage({
  message,
  streaming,
  roots,
}: {
  message: UIMessage;
  streaming: boolean;
  roots: readonly string[];
}) {
  const text = streaming ? "" : messageText(message);
  const files = readFiles(message, roots);
  // A path in the answer cites a file only when the answer read it.
  const cite = (code: string) => {
    const file = companionFile(code, roots);
    if (!file || !files.includes(file)) return null;
    return (
      <VaultLink className={CITATION_LINK} file={file}>
        <Icon name="doc" className="size-3 self-center" />
        <span className="truncate">{code}</span>
      </VaultLink>
    );
  };
  return (
    <Message from="assistant" data-chat-message="assistant">
      <CitationProvider cite={cite}>
        <MessageContent>{messageBody(message, streaming, roots)}</MessageContent>
      </CitationProvider>
      {!streaming && (files.length > 0 || text) ? (
        <div className="-ml-1.5 flex w-full flex-wrap items-start gap-1">
          {files.length > 0 ? (
            <Sources count={files.length}>
              {files.map((file) => (
                <Source key={file}>
                  <VaultLink className={SOURCE_LINK} file={file}>
                    <span className="truncate">{file}</span>
                  </VaultLink>
                </Source>
              ))}
            </Sources>
          ) : null}
          {text ? (
            <Tooltip label="Copy the answer" side="bottom">
              <Button
                aria-label="Copy the answer"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => copyText(text, "the answer")}
                size="icon-sm"
                variant="ghost"
              >
                <Icon name="copy" className="size-3.5" />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </Message>
  );
}

function QuestionMessage({
  message,
  onRestore,
  busy,
}: {
  message: UIMessage;
  onRestore: () => void;
  busy: boolean;
}) {
  return (
    <Message
      className="scroll-mt-4"
      data-chat-message="user"
      from="user"
      id={questionAnchor(message.id)}
    >
      <div className="flex w-full items-start justify-end gap-1">
        <Checkpoint disabled={busy} onRestore={onRestore} />
        <MessageContent>{messageBody(message, false, NO_ROOTS)}</MessageContent>
      </div>
    </Message>
  );
}

/** An empty conversation: what the agent reads, and questions that send on a click. */
function ChatStart({ onAsk }: { onAsk: (text: string) => void }) {
  return (
    <ConversationEmptyState
      id="chat-empty"
      description="The agent answers from this companion's specs, changes, notes and reports. It reads, and changes nothing."
    >
      <div className="grid gap-2">
        <h2 className="m-0 text-xs font-semibold text-muted">Try asking</h2>
        <Suggestions>
          {CHAT_SUGGESTIONS.map((suggestion) => (
            <Suggestion key={suggestion} onAsk={onAsk} suggestion={suggestion} />
          ))}
        </Suggestions>
      </div>
    </ConversationEmptyState>
  );
}

/**
 * A read-only conversation about one companion. It lives in this tab only: Studio keeps
 * nothing, and the route remounts it empty for another companion.
 */
export function ChatView({
  companion,
  roots = NO_ROOTS,
  transport: injected,
}: {
  companion: string;
  /** The companion's paths, which the agent's file paths start with; files link to the Vault. */
  roots?: readonly string[];
  transport?: ConstructorParameters<typeof DefaultChatTransport>[0];
}) {
  const { model, effort, setModel, setEffort } = useChatUi();
  const [transport] = useState(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: CHAT_ROUTE,
        credentials: "same-origin",
        prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => {
          // Read at send time, so a choice made mid-conversation applies to the next question.
          const settings = useChatUi.getState();
          return {
            body: {
              companion,
              id,
              messages: sentMessages(messages),
              trigger,
              messageId,
              model: settings.model,
              ...(effortless(settings.model) ? {} : { effort: settings.effort }),
            },
          };
        },
        ...injected,
      }),
  );
  const [queued, setQueuedState] = useState<QueuedQuestion[]>([]);
  // The queue as handlers see it: `onFinish` can run before a render picks up the last change,
  // and a stale queue would send the same question again.
  const queue = useRef<QueuedQuestion[]>([]);
  const setQueued = (next: QueuedQuestion[]) => {
    queue.current = next;
    setQueuedState(next);
  };
  const { messages, sendMessage, regenerate, setMessages, clearError, status, stop, error } =
    useChat({
      transport,
      // The next queued question goes once an answer ends; a failed, stopped or cut-off one holds the queue.
      onFinish: ({ isError, isAbort, isDisconnect }) => {
        const [next, ...rest] = queue.current;
        if (isError || isAbort || isDisconnect || !next) return;
        setQueued(rest);
        void sendMessage({ text: next.text });
      },
    });
  const field = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);
  const setCredentialOpen = useChatUi((state) => state.setCredentialOpen);
  const failed = error ? failureText(error) : null;
  const busy = status === "submitted" || status === "streaming";

  /** Sends now, or queues behind the answer that is coming. */
  const send = (text: string) => {
    if (busy) {
      nextId.current += 1;
      const id = `q${nextId.current}`;
      setQueued([...queue.current, { id, text }]);
      return true;
    }
    void sendMessage({ text });
    return true;
  };

  const startOver = () => {
    setMessages([]);
    setQueued([]);
    clearError();
    field.current?.focus();
  };
  const restore = (index: number) => {
    const question = messageText(messages[index]!);
    setMessages(messages.slice(0, index));
    // Held follow-ups belong to the conversation being cut.
    setQueued([]);
    clearError();
    if (field.current) {
      field.current.value = question;
      field.current.focus();
    }
  };
  const questions = messages.flatMap((message, index) =>
    message.role === "user" ? [{ id: message.id, text: messageText(message), index }] : [],
  );
  // Held here, so the session panel beside the conversation follows the same scroller.
  const scroll = useStickToBottom({ initial: "smooth", resize: "smooth" });

  return (
    <section
      className={cn(PAGE_PAD, "flex min-h-0 flex-1 gap-4 pb-4")}
      data-chat-view
      aria-label="Chat"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        <Conversation instance={scroll}>
          <ConversationContent>
            {messages.length === 0 ? (
              <ChatStart onAsk={send} />
            ) : (
              messages.map((message, index) =>
                message.role === "user" ? (
                  <QuestionMessage
                    busy={busy}
                    key={message.id}
                    message={message}
                    onRestore={() => restore(index)}
                  />
                ) : (
                  <AnswerMessage
                    key={message.id}
                    message={message}
                    roots={roots}
                    streaming={status === "streaming" && index === messages.length - 1}
                  />
                ),
              )
            )}
            {status === "submitted" ? (
              <p
                className="m-0 flex items-center gap-2 text-sm text-muted"
                id="chat-thinking"
                aria-live="polite"
              >
                <Spinner aria-hidden="true" role={undefined} className="size-3.5 text-accent" />
                Reading the companion…
              </p>
            ) : null}
            {failed !== null ? (
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-bad bg-bad-soft px-3 py-2 text-sm"
                id="chat-error"
                role="alert"
              >
                <p className="m-0 min-w-0 flex-1 text-bad">The answer failed: {failed}</p>
                {isCredentialFailure(failed) ? (
                  <Button
                    data-chat-error-credential
                    onClick={() => setCredentialOpen(true)}
                    size="sm"
                    variant="primary"
                  >
                    <Icon name="key" className="size-3.5" />
                    Open credential
                  </Button>
                ) : null}
                <Button onClick={() => void regenerate()} size="sm">
                  <Icon name="refresh" className="size-3.5" />
                  Try again
                </Button>
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="mx-auto grid w-full max-w-[72ch] gap-1.5">
          <Queue
            items={queued}
            note={status === "error" ? "held until an answer succeeds" : undefined}
            onRemove={(id) => setQueued(queue.current.filter((item) => item.id !== id))}
          />
          <PromptInput onSubmit={send}>
            <PromptInputTextarea
              ref={field}
              autoFocus
              aria-label="Your question"
              placeholder={
                busy
                  ? "Ask a follow-up; it sends when this answer ends"
                  : "Ask about this companion's specs, changes or notes"
              }
            />
            <PromptInputToolbar>
              <PromptInputTools>
                <ModelSelector
                  group={PROVIDER}
                  label="Model"
                  onChange={setModel}
                  options={MODEL_OPTIONS}
                  value={model}
                />
                <ModelSelector
                  disabled={effortless(model)}
                  label="Effort"
                  onChange={setEffort}
                  options={EFFORT_OPTIONS}
                  prefix="Effort"
                  value={effort}
                />
              </PromptInputTools>
              <div className="flex items-center gap-3">
                <Context budget={CHAT_HISTORY_BUDGET} used={replayedChars(messages)} />
                <PromptInputSubmit status={status} onStop={() => void stop()} />
              </div>
            </PromptInputToolbar>
          </PromptInput>
          <div className="flex min-h-7 items-center justify-between gap-3 px-1">
            <PromptInputHint />
            {messages.length > 0 && !busy ? (
              <Button onClick={startOver} size="sm" variant="ghost">
                <Icon name="plus" className="size-3.5" />
                New conversation
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <SessionPanel
        busy={busy}
        companion={companion}
        onRestore={restore}
        questions={questions}
        scroll={scroll}
      />
    </section>
  );
}
