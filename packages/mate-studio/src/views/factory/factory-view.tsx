import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState, type ReactNode } from "react";

import { type FactoryAction, type FactoryPayload } from "../../server/factory";
import { Warnings } from "../warnings";
import { ListCard, PAGE_PAD, Pills } from "../../components/view-parts";
import { cn } from "../../lib/cn";
import { SidePanel } from "../../shell/panel";
import { type GraphProgress, WorkflowGraphView } from "../workflow/delivery-path";
import { FactoryCompanion } from "./factory-companion";
import { AgentsDialog } from "./agents-dialog";
import { FactoryForm } from "./factory-form";
import { useFactoryUi } from "../../stores/factory-ui";
import { matchesFilter, useFactoryKeys, useNeedsYou, useNotificationOffer } from "./factory-live";
import { ageText } from "./age";
import { useOutcomeLog } from "./use-outcome-log";
import { OutcomeTerminal } from "../../terminal/outcome-terminal";
import {
  type AgentQuestion,
  type FactoryRunView,
  factoryLogRoute,
  factoryLogStreamRoute,
  type OutcomeAction,
  outcomeActions,
  questionsOf,
  REPORT_VIEW_PREFIX,
  type StudioWorkset,
} from "@uniqbit/mate-core/studio";
import {
  type Activity,
  ACTIVITY_LABELS,
  activityOf,
  type AttentionKind,
  factoryHome,
  type FactoryHome,
  milestonesOf,
  nextStepOf,
  type OutcomeItem,
  pathNodeOf,
  situationOf,
} from "./outcome";
import { workflowPlan, type WorkflowPath } from "../workflow/steps";

interface FactoryProps {
  payload: FactoryPayload;
  companionDigest: string;
  writable: boolean;
  /** Live Workset sessions by Workset id; `null` outside factory mode or without the terminal. */
  sessions?: Record<string, string> | null;
  /** AFK runs by Workset id; `null` without the runner, which hides its controls. */
  runs?: Record<string, FactoryRunView> | null;
  /** Render time, for ages; without it no age is shown. */
  now?: number | undefined;
  /** The Outcome whose dialog is open, from the address. */
  openId?: string | undefined;
  /** The factory broker is reachable, so the Agents panel is offered. */
  factoryMode?: boolean;
}

const ATTENTION_LABELS: Record<AttentionKind, string> = {
  control: "You have control",
  decision: "Decision needed",
  review: "Plan ready for review",
  merge: "Ready to merge",
  publish: "Ready to publish",
  problem: "Something went wrong",
};

/** What each kind of attention expects of the person, under its heading in the dialog. */
const ATTENTION_HINTS: Partial<Record<AttentionKind, string>> = {
  decision:
    "The run is paused on this. Pick an option or answer in your words; it continues on its own.",
  review:
    "Read each report, then approve to start building, or request a change to revise the plan.",
  merge: "Merge the delivery branch on your forge; the board picks it up on its next refresh.",
  publish: "Publishing commits, tags and pushes the archived specs to the companion.",
  problem: "Retry runs the stage again; take control to fix it yourself.",
  control:
    "You work in the factory's own conversation. Exit Claude, then return the Outcome to automation; the factory checks what changed and continues.",
};

/** What Take control does, beside the button. */
const TAKE_CONTROL_HINT =
  "Pauses automation after the current stage; you continue the factory's own conversation here.";

const RECENT_COMPLETED = 5;

/** Which list the board shows; `all` shows each. */
type ListFilter = "all" | "attention" | "active" | "later" | "completed";

/** "Decisions needed (3)" when the agent asked several questions together. */
function attentionLabel(kind: AttentionKind, run: FactoryRunView | undefined): string {
  const count = run?.state === "waiting" ? questionsOf(run).length : 0;
  return kind === "decision" && count > 1 ? `Decisions needed (${count})` : ATTENTION_LABELS[kind];
}

interface HomeContext {
  companionDigest: string;
  writable: boolean;
  sessions: Record<string, string> | null;
  /** `false` without the runner: the policy then accepts only Start and Later. */
  runner: boolean;
  now: number | undefined;
  /** The companion's Delivery Path, drawn in each dialog with the Outcome's place on it. */
  path: WorkflowPath;
  /** `jira` adds an optional Ticket field to the forms that create an Outcome. */
  ticketFormat: "none" | "jira";
}

/** Optional Jira key for a new Outcome; it names the Outcome's Delivery Branch. */
function TicketField({ context }: { context: HomeContext }) {
  if (context.ticketFormat !== "jira") return null;
  return (
    <input
      name="ticket"
      className="outcome-ticket"
      placeholder="ABC-123"
      aria-label="Ticket (optional)"
      autoComplete="off"
      spellCheck={false}
    />
  );
}

/** The actions that move an Outcome forward; the rest stay quiet. */
const PRIMARY_ACTIONS = new Set(["answer", "start-apply", "publish", "return", "retry", "start"]);

function ActionForm({
  id,
  action,
  label,
  children,
}: {
  id: string;
  action: FactoryAction;
  label: string;
  children?: ReactNode;
}) {
  return (
    <FactoryForm id={id} action={action} className="factory-action">
      {children}
      <button type="submit" className={PRIMARY_ACTIONS.has(action) ? "factory-primary" : undefined}>
        {label}
      </button>
    </FactoryForm>
  );
}

/** A control for one action; none when Studio is read-only or the Outcome does not accept it. */
function actionFor(item: OutcomeItem, context: HomeContext) {
  const accepted = outcomeActions(item.workset, item.run, context);
  return (action: OutcomeAction, label: string, children?: ReactNode) =>
    context.writable && accepted.has(action) ? (
      <ActionForm id={item.workset.id} action={action} label={label}>
        {children}
      </ActionForm>
    ) : null;
}

/** The Outcome's state as a coloured dot; the text beside it says the same in words. */
function ActivityDot({ activity }: { activity: Activity }) {
  return (
    <span
      className="activity-dot"
      data-activity={activity}
      title={ACTIVITY_LABELS[activity]}
      aria-hidden="true"
    />
  );
}

/** Plain-language input; Start runs it at once, Save for later keeps it unstarted. */
function OutcomeInput({ repositories, context }: { repositories: string[]; context: HomeContext }) {
  if (!context.writable) {
    return (
      <p className="note">Read-only mode. Start Studio with --writable to describe outcomes.</p>
    );
  }
  if (repositories.length === 0) {
    return (
      <p className="note">Link a Working Repository to this companion to describe outcomes.</p>
    );
  }
  return (
    <FactoryForm action="create" className="outcome-input" data-outcome-input="">
      <label>
        <span className="outcome-input-label">What should we build or improve?</span>
        <textarea
          name="text"
          rows={3}
          required
          placeholder="Make onboarding easier: fewer signup steps, and keep authentication working."
        />
      </label>
      <div className="outcome-input-actions">
        <button type="submit" name="start" value="start" className="factory-primary">
          Start <kbd>⌘↵</kbd>
        </button>
        <button type="submit" name="start" value="later">
          Save for later
        </button>
        <TicketField context={context} />
        {repositories.length > 1 ? (
          <select name="repository" required aria-label="Working Repository">
            {repositories.map((repository) => (
              <option key={repository} value={repository}>
                {repository}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </FactoryForm>
  );
}

/** Milestones as a row of pips and a count; the title names the next one. */
function MilestoneTrack({ workset }: { workset: StudioWorkset }) {
  const milestones = milestonesOf(workset);
  const reached = milestones.filter((milestone) => milestone.reached).length;
  const next = milestones.find((milestone) => !milestone.reached);
  return (
    <span
      className="outcome-row-track"
      title={`${reached} of ${milestones.length} milestones${next ? `; next: ${next.label}` : ""}`}
    >
      <span className="outcome-row-pips" aria-hidden="true">
        {milestones.map((milestone) => (
          <i key={milestone.label} data-reached={milestone.reached ? "true" : "false"} />
        ))}
      </span>
      <span className="mono">
        {reached}/{milestones.length}
      </span>
    </span>
  );
}

function Checks({ checks }: { checks?: { name: string; passed: boolean }[] | undefined }) {
  if (!checks?.length) return null;
  return (
    <ul className="outcome-checks" aria-label="Checks">
      {checks.map((check) => (
        <li key={check.name} data-passed={check.passed ? "true" : "false"}>
          {check.passed ? "✓" : "✗"} {check.name}
        </li>
      ))}
    </ul>
  );
}

/** Review plan and View changes, when there is something to look at. */
function ResultLinks({ item }: { item: OutcomeItem }) {
  const reports = Object.entries(item.run?.reviewReports ?? {});
  const compare = item.run?.compareUrl;
  if (reports.length === 0 && !compare) return null;
  return (
    <div className="outcome-results">
      {reports.map(([change, id]) => (
        <a key={change} href={`${REPORT_VIEW_PREFIX}${id}`} target="_blank" rel="noreferrer">
          Review plan{reports.length > 1 ? ` · ${change}` : ""}
        </a>
      ))}
      {compare ? (
        <a href={compare} target="_blank" rel="noreferrer">
          View changes
        </a>
      ) : null}
    </div>
  );
}

/** The stored review report per linked change, each in a frame; missing ones are named. */
function ReviewReports({ item }: { item: OutcomeItem }) {
  const stored = item.run?.reviewReports ?? {};
  return (
    <div className="factory-review-reports">
      {item.workset.changes.map((change) =>
        stored[change] ? (
          <figure key={change} className="factory-review-report">
            <figcaption className="mono">
              {change} ·{" "}
              <a href={`${REPORT_VIEW_PREFIX}${stored[change]}`} target="_blank" rel="noreferrer">
                open
              </a>
            </figcaption>
            <iframe
              src={`${REPORT_VIEW_PREFIX}${stored[change]}`}
              title={`Review report for ${change}`}
              loading="lazy"
              sandbox="allow-scripts allow-modals"
            />
          </figure>
        ) : (
          <p key={change} className="note" data-report-missing={change}>
            No review report for <span className="mono">{change}</span>.
          </p>
        ),
      )}
    </div>
  );
}

/** Before archive feedback revises the plan; after it, it starts a new Outcome. */
function FeedbackField({ item, context }: { item: OutcomeItem; context: HomeContext }) {
  if (!context.writable) return null;
  const { stage } = item.workset;
  if (stage === "publish" || stage === "done") {
    return (
      <FactoryForm action="create" className="outcome-feedback">
        <textarea name="text" rows={2} required aria-label="A new outcome" />
        <TicketField context={context} />
        <button type="submit" name="start" value="start">
          Start as a new outcome
        </button>
      </FactoryForm>
    );
  }
  return actionFor(item, context)(
    "feedback",
    "Request a change",
    <textarea
      name="feedback"
      rows={2}
      required
      aria-label="Request a change"
      placeholder="What should change?"
    />,
  );
}

const runActive = (run: FactoryRunView | undefined): boolean =>
  run?.state === "running" || run?.state === "queued";

/** The run's log in its dialog; the client follows it live while the dialog is open. */
function OutcomeLog({ item }: { item: OutcomeItem }) {
  const { workset, run } = item;
  const active = runActive(run);
  if (!run?.hasLog && !active) return null;
  return (
    <section className="outcome-log-section" aria-label="Log">
      <header className="outcome-section-head">
        <h3>Log</h3>
        {active ? <span className="outcome-log-live">live</span> : null}
        <a href={factoryLogRoute(workset.id)} target="_blank" rel="noreferrer">
          Full log
        </a>
      </header>
      <LiveLog id={workset.id} />
    </section>
  );
}

/** The stored log, then the running stage's text and tool activity as it arrives, by who wrote it. */
function LiveLog({ id }: { id: string }) {
  const { pieces, ended } = useOutcomeLog(factoryLogStreamRoute(id));
  const ref = useRef<HTMLPreElement>(null);
  // Follow the end unless the person scrolled up to read; measured before new text arrives.
  const following = useRef(true);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    const pre = ref.current;
    if (pre && pieces.length > 0 && following.current) pre.scrollTop = pre.scrollHeight;
  }, [pieces]);
  const toEnd = () => {
    const pre = ref.current;
    if (!pre) return;
    pre.scrollTop = pre.scrollHeight;
    following.current = true;
    setReading(false);
  };
  return (
    <div className="outcome-log-frame">
      <pre
        ref={ref}
        role="log"
        aria-label="Run log"
        // Scrollable by keyboard.
        tabIndex={0}
        onScroll={(event) => {
          const pre = event.currentTarget;
          following.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
          setReading(!following.current);
        }}
        className="outcome-log"
        data-outcome-log={factoryLogStreamRoute(id)}
        data-ended={ended || undefined}
      >
        {pieces.length > 0 ? (
          pieces.map((piece, index) => (
            // Pieces only grow or append, so their place is their identity.
            // oxlint-disable-next-line no-array-index-key
            <span key={index} data-kind={piece.kind}>
              {piece.text}
            </span>
          ))
        ) : (
          <span className="outcome-log-empty">Waiting for output.</span>
        )}
      </pre>
      {reading ? (
        <button type="button" className="outcome-log-jump" onClick={toEnd}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

/** While a person has control: the way back first, then their session on the factory's conversation. */
function ControlSheet({ item, context }: { item: OutcomeItem; context: HomeContext }) {
  const { workset, run } = item;
  const stepped = useFactoryUi((state) => state.stepped);
  return (
    <div className="factory-sheet outcome-control">
      <div className="outcome-control-bar">
        {run?.control?.reason ? (
          <p className="outcome-control-reason">{run.control.reason}</p>
        ) : null}
        {actionFor(item, context)("return", "Return to automation")}
      </div>
      {context.sessions && run?.control?.mode === "manual" ? (
        <OutcomeTerminal
          outcome={workset.id}
          companion={context.companionDigest}
          focus={!stepped}
        />
      ) : (
        <p className="note">The terminal is not available in this Studio.</p>
      )}
    </div>
  );
}

/** Take control and what it does, for an Outcome whose conversation the factory still drives. */
function TakeControl({ item, context }: { item: OutcomeItem; context: HomeContext }) {
  const { workset, run } = item;
  if (!run?.conversation || run.control || workset.stage === "done") return null;
  const form = actionFor(item, context)("take-control", "Take control");
  if (!form) return null;
  return (
    <div className="outcome-control-offer">
      {form}
      <p className="note">{TAKE_CONTROL_HINT}</p>
    </div>
  );
}

/** Between Take control and the handover: what the person waits for, above the live log. */
function TakeoverPending({
  run,
  now,
}: {
  run: FactoryRunView | undefined;
  now: number | undefined;
}) {
  if (run?.control?.mode !== "takeover-requested") return null;
  const stage = run.state === "running" ? run.stage : null;
  const since = run.control.updatedAt ? ageText(run.control.updatedAt, now) : "";
  return (
    <section
      className="outcome-dialog-attention"
      data-kind="control"
      data-pending=""
      role="status"
      aria-label="Taking control"
    >
      <h3>Taking control</h3>
      <p className="outcome-attention-hint">
        Control passes to you once{" "}
        {stage ? (
          <>
            the <span className="mono">{stage}</span> stage
          </>
        ) : (
          "the current stage"
        )}{" "}
        ends; the log below keeps following it. The terminal opens here then.
        {since ? <span className="factory-age mono"> · asked {since} ago</span> : null}
      </p>
    </section>
  );
}

/** The run in a few words: what it does at which stage, and for how long. */
function runText(run: FactoryRunView | undefined, now: number | undefined): string {
  if (!run || run.state === "idle") return "idle";
  const since = run.state === "running" ? run.startedAt : run.updatedAt;
  return `${run.state} ${run.stage}${since ? ` · ${ageText(since, now)}` : ""}`;
}

const reportsMissing = ({ workset, run }: OutcomeItem): boolean =>
  workset.changes.some((change) => !run?.reviewReports?.[change]);

/** What can be done to the run itself, always in view; nothing when nothing applies. */
function RunActions({ item, context }: { item: OutcomeItem; context: HomeContext }) {
  const { workset, run } = item;
  const form = actionFor(item, context);
  const active = runActive(run);
  const open = workset.stage !== "done";
  // Retry and missing reports are offered where the problem or the review is shown.
  // No action sets the stage: a Later Outcome moves only by Start.
  return (
    <div className="outcome-actions" role="group" aria-label="Run actions">
      {open && !workset.queuedAt ? form("start", "Start") : null}
      {active ? form("cancel", "Cancel run") : null}
      {workset.stage === "human-review" && !reportsMissing(item)
        ? form("regenerate", "Regenerate reports")
        : null}
      {open && workset.queuedAt ? form("later", "Move to later") : null}
    </div>
  );
}

/** The execution facts beside the map: stage, changes, run and branch. */
function Facts({ item, context }: { item: OutcomeItem; context: HomeContext }) {
  const { workset, run } = item;
  return (
    <dl className="outcome-facts">
      <dt>Stage</dt>
      <dd>{workset.stageLabel}</dd>
      <dt>Run</dt>
      <dd>{runText(run, context.now)}</dd>
      <dt>Changes</dt>
      <dd className="mono">{workset.changes.join(", ") || "none yet"}</dd>
      {run?.pushedBranch ? (
        <>
          <dt>Branch</dt>
          <dd className="mono">{run.pushedBranch}</dd>
        </>
      ) : null}
      <dt>Id</dt>
      <dd className="mono">{workset.id}</dd>
    </dl>
  );
}

/** The current node's note on the map: how the stage stands, with an age while it runs. */
function progressNote(item: OutcomeItem, activity: Activity, now: number | undefined): string {
  const { run } = item;
  const label = ACTIVITY_LABELS[activity].toLowerCase();
  if (run?.state === "running" && now !== undefined)
    return `${label} · ${ageText(run.startedAt, now)}`;
  return activity === "idle" ? "" : label;
}

/** The recommendation, marked in words beside the option it belongs to. */
function RecommendedTag() {
  return <span className="factory-recommended">recommended</span>;
}

/** A single question: one click on an option sends it; number keys pick options. */
function SingleDecision({
  item,
  asked,
  round,
  context,
}: {
  item: OutcomeItem;
  asked: AgentQuestion;
  round: string;
  context: HomeContext;
}) {
  const act = context.writable && outcomeActions(item.workset, item.run, context).has("answer");
  return (
    <div className="factory-sheet">
      <p className="factory-question">{asked.question}</p>
      {asked.options?.length ? (
        <div className="factory-options" role="group" aria-label="Answers">
          {asked.options.map((option, index) => {
            const recommended = option === asked.recommended;
            // Number keys reach the first nine options.
            const shortcut = index < 9 ? String(index + 1) : undefined;
            return act ? (
              <FactoryForm
                key={option}
                id={item.workset.id}
                action="answer"
                className="factory-option"
              >
                <input type="hidden" name="round" value={round} />
                <input type="hidden" name="answer" value={option} />
                <button
                  type="submit"
                  data-recommended={recommended ? "true" : "false"}
                  data-option-key={shortcut}
                  aria-keyshortcuts={shortcut}
                >
                  {shortcut ? <kbd aria-hidden="true">{shortcut}</kbd> : null}
                  <span>{option}</span>
                  {recommended ? <RecommendedTag /> : null}
                </button>
              </FactoryForm>
            ) : (
              <span
                key={option}
                className="factory-choice"
                data-recommended={recommended ? "true" : "false"}
              >
                {option}
                {recommended ? <RecommendedTag /> : null}
              </span>
            );
          })}
        </div>
      ) : asked.recommended ? (
        <p className="note">Recommended: {asked.recommended}</p>
      ) : null}
      {actionFor(item, context)(
        "answer",
        asked.options?.length ? "Send my words" : "Answer",
        <>
          <input type="hidden" name="round" value={round} />
          <textarea
            name="answer"
            rows={2}
            required
            aria-label="Answer in your words"
            placeholder={asked.options?.length ? "Or answer in your words" : "Your answer"}
          />
        </>,
      )}
    </div>
  );
}

/** One question of a round: its options as choices, none chosen, and own words that override. */
function QuestionBlock({ asked, index }: { asked: AgentQuestion; index: number }) {
  return (
    <fieldset className="factory-question-set">
      <legend className="factory-question">
        <span className="mono">{index + 1}.</span> {asked.question}
      </legend>
      {asked.options?.length ? (
        <div className="factory-choices">
          {asked.options.map((option) => {
            const recommended = option === asked.recommended;
            return (
              <label
                key={option}
                className="factory-choice"
                data-recommended={recommended ? "true" : "false"}
              >
                <input type="radio" name={`choice-${index}`} value={option} />
                <span>{option}</span>
                {recommended ? <RecommendedTag /> : null}
              </label>
            );
          })}
        </div>
      ) : asked.recommended ? (
        <p className="note">Recommended: {asked.recommended}</p>
      ) : null}
      <textarea
        name={`answer-${index}`}
        rows={1}
        aria-label={`Answer to question ${index + 1} in your words`}
        placeholder={
          asked.options?.length ? "Or in your words (overrides the choice)" : "Your answer"
        }
      />
    </fieldset>
  );
}

/** How many questions of a round have a choice or words, read from the form. */
function answeredIn(form: HTMLFormElement, count: number): number {
  const data = new FormData(form);
  let answered = 0;
  for (let index = 0; index < count; index += 1) {
    const words = data.get(`answer-${index}`);
    if (data.get(`choice-${index}`) || (typeof words === "string" && words.trim())) answered += 1;
  }
  return answered;
}

/** The questions the agent asked together: answered together, nothing chosen for the person. */
function GroupedDecision({
  item,
  questions,
  round,
  context,
}: {
  item: OutcomeItem;
  questions: AgentQuestion[];
  round: string;
  context: HomeContext;
}) {
  const [answered, setAnswered] = useState(0);
  if (!context.writable || !outcomeActions(item.workset, item.run, context).has("answer")) {
    return (
      <ol className="outcome-history">
        {questions.map((asked) => (
          <li key={asked.question}>{asked.question}</li>
        ))}
      </ol>
    );
  }
  const count = (event: FormEvent<HTMLDivElement>) => {
    const form = event.currentTarget.closest("form");
    if (form) setAnswered(answeredIn(form, questions.length));
  };
  const recommended = questions.every((asked) => asked.recommended);
  return (
    <div className="factory-sheet">
      <FactoryForm id={item.workset.id} action="answer" className="factory-action factory-round">
        <input type="hidden" name="round" value={round} />
        <div className="factory-round-questions" onChange={count} onInput={count}>
          {questions.map((asked, index) => (
            <QuestionBlock key={asked.question} asked={asked} index={index} />
          ))}
        </div>
        <div className="factory-sheet-actions">
          <button type="submit" className="factory-primary" disabled={answered < questions.length}>
            Send answers
          </button>
          <span className="factory-round-count mono" aria-live="polite">
            {answered} of {questions.length} answered
          </span>
        </div>
      </FactoryForm>
      {recommended ? (
        <FactoryForm id={item.workset.id} action="answer" className="factory-action">
          <input type="hidden" name="round" value={round} />
          {questions.map((asked, index) => (
            <input
              key={asked.question}
              type="hidden"
              name={`choice-${index}`}
              value={asked.recommended}
            />
          ))}
          <button type="submit">Accept all recommendations</button>
        </FactoryForm>
      ) : null}
    </div>
  );
}

/** The questions the agent asked: one alone is answered in a click, several together. */
function DecisionSheet({
  item,
  run,
  context,
}: {
  item: OutcomeItem;
  run: Extract<FactoryRunView, { state: "waiting" }>;
  context: HomeContext;
}) {
  const questions = questionsOf(run);
  if (questions.length === 1) {
    return (
      <SingleDecision item={item} asked={questions[0]!} round={run.round ?? ""} context={context} />
    );
  }
  return (
    <GroupedDecision item={item} questions={questions} round={run.round ?? ""} context={context} />
  );
}

/** What a person does for one attention item, opened in place. */
function AttentionBody({
  item,
  kind,
  context,
}: {
  item: OutcomeItem;
  kind: AttentionKind;
  context: HomeContext;
}) {
  const { run } = item;
  const form = actionFor(item, context);
  if (kind === "control") return <ControlSheet item={item} context={context} />;
  if (kind === "decision" && run?.state === "waiting") {
    return <DecisionSheet item={item} run={run} context={context} />;
  }
  if (kind === "problem") {
    return (
      <div className="factory-sheet">
        <p className="factory-problems">
          {run?.state === "failed" ? run.reason : "Stopped when Studio restarted."}
        </p>
        {run?.needsCredential ? <OpenAgents label="Set the agent credential" /> : null}
        {form("retry", "Retry")}
      </div>
    );
  }
  if (kind === "review") {
    const missing = reportsMissing(item);
    return (
      <div className="factory-sheet">
        <ReviewReports item={item} />
        <div className="factory-sheet-actions">
          {form("start-apply", "Approve")}
          {missing ? form("regenerate", "Regenerate") : null}
        </div>
        <FeedbackField item={item} context={context} />
      </div>
    );
  }
  if (kind === "merge") {
    return (
      <div className="factory-sheet">
        {run?.compareUrl ? (
          <a href={run.compareUrl} target="_blank" rel="noreferrer">
            Open {run.pushedBranch ?? "the branch"} to merge
          </a>
        ) : (
          <p className="note">
            Merge <span className="mono">{run?.pushedBranch ?? "the delivery branch"}</span>, then
            refresh.
          </p>
        )}
      </div>
    );
  }
  return <div className="factory-sheet">{form("publish", "Publish")}</div>;
}

const dialogId = (id: string) => `outcome-${id}`;

/**
 * Opens, steps to or closes an Outcome's dialog through the address, so it can be linked,
 * a reload reopens it and Back closes it. Stepping replaces the entry; opening adds one.
 */
function useOutcomeAddress() {
  const navigate = useNavigate();
  const go = (outcome: string | undefined, replace = false) =>
    void navigate({
      to: "/factory",
      search: (previous) => ({ ...previous, outcome }),
      replace,
      resetScroll: false,
    });
  return {
    open: (id: string) => go(id),
    step: (id: string) => go(id, true),
    close: () => go(undefined),
  };
}

/** One line per Outcome: what it is and where it is; the row opens the dialog. */
function OutcomeRow({
  item,
  context,
  lead,
  progress = true,
  trailing,
}: {
  item: OutcomeItem;
  context: HomeContext;
  /** Replaces the situation, e.g. the decision an attention row waits on. */
  lead?: ReactNode;
  /** Milestones reached; off where they say nothing, as for Later and Done. */
  progress?: boolean;
  trailing?: ReactNode;
}) {
  const { workset, run } = item;
  const situation = situationOf(workset, run);
  const since = situation.at ?? (run?.updatedAt || workset.queuedAt);
  const address = useOutcomeAddress();
  return (
    <li className="outcome-row-item" data-workset={workset.id}>
      <button
        type="button"
        className="outcome-row"
        data-outcome-row=""
        onClick={() => {
          useFactoryUi.getState().setStepped(false);
          address.open(workset.id);
        }}
      >
        <ActivityDot activity={activityOf(workset, run)} />
        <span className="outcome-row-title">{workset.title}</span>
        <span className="outcome-row-where">{lead ?? situation.text}</span>
        <span className="outcome-row-progress">
          {progress ? <MilestoneTrack workset={workset} /> : null}
        </span>
        <span className="outcome-row-age mono">{since ? ageText(since, context.now) : ""}</span>
      </button>
      {trailing}
    </li>
  );
}

function OutcomeList({
  label,
  section,
  count,
  children,
}: {
  label: string;
  section: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="outcome-list-section" data-section={section}>
      <ListCard title={label} count={count} tone={section === "attention" ? "warn" : undefined}>
        <ul className="outcome-list">{children}</ul>
      </ListCard>
    </div>
  );
}

const sameText = (a: string, b: string): boolean =>
  a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();

/** What the person is asked to do, with what it expects of them. */
function AttentionSection({
  item,
  kind,
  context,
}: {
  item: OutcomeItem;
  kind: AttentionKind;
  context: HomeContext;
}) {
  return (
    <section className="outcome-dialog-attention" data-kind={kind} aria-label="Needs you">
      <h3>{attentionLabel(kind, item.run)}</h3>
      {ATTENTION_HINTS[kind] ? (
        <p className="outcome-attention-hint">{ATTENTION_HINTS[kind]}</p>
      ) : null}
      <AttentionBody item={item} kind={kind} context={context} />
    </section>
  );
}

/** Where the Outcome is: its situation, the next step, checks, results and problems. */
function OutcomeStatus({
  item,
  situation,
}: {
  item: OutcomeItem;
  situation: ReturnType<typeof situationOf>;
}) {
  const { workset, run } = item;
  const next = nextStepOf(workset, run);
  return (
    <section className="outcome-dialog-status" aria-label="Where it is">
      <p className="outcome-situation">{situation.text}</p>
      {/* "Waiting for your answer." needs no "Next: Waiting for your answer". */}
      {sameText(next, situation.text) ? null : (
        <p className="outcome-next">
          <span className="muted">Next</span> {next}
        </p>
      )}
      <Checks checks={situation.checks} />
      <ResultLinks item={item} />
      {workset.problems.length > 0 ? (
        <ul className="factory-problems">
          {workset.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The run's reported situations, newest first; nothing before the first report. */
function History({ run, now }: { run: FactoryRunView | undefined; now: number | undefined }) {
  if (!run?.situations?.length) return null;
  return (
    <section className="outcome-history-section" aria-label="What happened">
      <h3>What happened</h3>
      <ol className="outcome-history">
        {run.situations.map((entry) => (
          <li key={entry.at}>
            <span className="factory-age mono">{ageText(entry.at, now)}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Everything about one Outcome, in the slide-over panel. It leads with what needs the person,
 * then the log, status and the run's actions, and history; Details holds where the Outcome is
 * on the Delivery Path and the execution facts. In control the terminal takes the width.
 */
function OutcomePanel({
  item,
  kind,
  context,
}: {
  item: OutcomeItem;
  kind: AttentionKind | null;
  context: HomeContext;
}) {
  const { workset, run } = item;
  const situation = situationOf(workset, run);
  const activity = activityOf(workset, run);
  // How long it has been in this state: running since the turn started, else since the last change.
  const since = run?.state === "running" ? run.startedAt : run?.updatedAt || situation.at;
  const id = dialogId(workset.id);
  const progress: GraphProgress = {
    current: pathNodeOf(workset),
    activity,
    note: progressNote(item, activity, context.now),
  };
  return (
    <div
      id={id}
      className="outcome-dialog"
      data-outcome-panel=""
      data-workset={workset.id}
      data-layout={kind === "control" ? "control" : undefined}
    >
      <header className="outcome-dialog-head">
        <div className="outcome-dialog-heading">
          <h2 id={`${id}-title`}>{workset.title}</h2>
          <p className="outcome-dialog-state">
            <ActivityDot activity={activity} />
            {ACTIVITY_LABELS[activity]}
            {since ? (
              <span className="factory-age mono">· {ageText(since, context.now)}</span>
            ) : null}
          </p>
        </div>
      </header>
      <div className="outcome-dialog-main">
        {kind ? <AttentionSection item={item} kind={kind} context={context} /> : null}
        <TakeoverPending run={run} now={context.now} />
        <OutcomeLog item={item} />
        <OutcomeStatus item={item} situation={situation} />
        <RunActions item={item} context={context} />
        <TakeControl item={item} context={context} />
        <History run={run} now={context.now} />
        {workset.intent ? (
          <section className="outcome-intent-section" aria-label="Request">
            <h3>Request</h3>
            <p className="outcome-intent">{workset.intent}</p>
          </section>
        ) : null}
        {kind !== "review" ? <FeedbackField item={item} context={context} /> : null}
        <details className="outcome-dialog-rail" aria-label="Details">
          <summary>Details</summary>
          {/* In control the terminal gets the width; stage and changes stay in the facts. */}
          {kind === "control" ? null : (
            <WorkflowGraphView
              path={context.path}
              progress={progress}
              label="Where it is on the Delivery Path"
            />
          )}
          <Facts item={item} context={context} />
        </details>
      </div>
    </div>
  );
}

function Completed({
  items,
  context,
  expanded,
}: {
  items: OutcomeItem[];
  context: HomeContext;
  /** While filtering every match shows, folded or not. */
  expanded: boolean;
}) {
  if (items.length === 0) return null;
  const rest = expanded ? [] : items.slice(RECENT_COMPLETED);
  const row = (item: OutcomeItem) => (
    <OutcomeRow key={item.workset.id} item={item} context={context} progress={false} />
  );
  return (
    <OutcomeList label="Done" section="completed" count={items.length}>
      {(expanded ? items : items.slice(0, RECENT_COMPLETED)).map(row)}
      {rest.length > 0 ? (
        <li>
          <details className="outcome-list-more">
            <summary>Show all {items.length}</summary>
            <ul className="outcome-list">{rest.map(row)}</ul>
          </details>
        </li>
      ) : null}
    </OutcomeList>
  );
}

/** The journey an Outcome takes, shown before the first one exists. */
function FirstRun() {
  return (
    <section className="factory-first-run" aria-label="How the factory works">
      <h3>How an outcome gets delivered</h3>
      <ol>
        <li>Describe what you want built or improved, and start it.</li>
        <li>The factory clarifies and explores; answer its questions as they come up.</li>
        <li>It writes a plan. Review it, then approve or request a change.</li>
        <li>It builds the plan on a delivery branch. Merge the branch, then publish.</li>
      </ol>
      <p className="note">
        Everything that needs you shows under Needs you. Open an outcome to follow its log or take
        control of its conversation.
      </p>
    </section>
  );
}

/**
 * The board's lists in board order and as the filter leaves them. Each Outcome is listed once:
 * what needs the person is not repeated under Running.
 */
function useBoard(home: FactoryHome) {
  const filter = useFactoryUi((state) => state.filter);
  const query = filter.trim();
  const kinds = new Map(home.attention.map((item) => [item.workset.id, item.kind]));
  const running = home.active.filter((item) => !kinds.has(item.workset.id));
  // Title, situation and attention, as the rows show them.
  const shows = (item: OutcomeItem) => {
    if (!query) return true;
    const kind = kinds.get(item.workset.id);
    const label = kind ? attentionLabel(kind, item.run) : "";
    return matchesFilter(
      `${item.workset.title} ${situationOf(item.workset, item.run).text} ${label}`,
      query,
    );
  };
  const attention = home.attention.filter(shows);
  const runningShown = running.filter(shows);
  const later = home.later.filter(shows);
  const completed = home.completed.filter(shows);
  return {
    kinds,
    query,
    // Dialogs step through Outcomes as the unfiltered lists order them.
    ordered: [...home.attention, ...running, ...home.later, ...home.completed],
    attention,
    running: { all: running, shown: runningShown },
    later,
    completed,
    shownCount: attention.length + runningShown.length + later.length + completed.length,
  };
}

/** Opens the Agents panel. */
function OpenAgents({ label }: { label: string }) {
  const setAgentsOpen = useFactoryUi((state) => state.setAgentsOpen);
  return (
    <button type="button" data-open-agents="" onClick={() => setAgentsOpen(true)}>
      {label}
    </button>
  );
}

/** The filter, the keys and the offer to notify, above the board. */
function BoardToolbar({
  count,
  worksets,
  writable,
  factoryMode,
  onPass,
  children,
}: {
  count: number;
  worksets: number;
  writable: boolean;
  factoryMode: boolean;
  /** Starts the pass through what needs the person; absent when nothing does. */
  onPass?: () => void;
  children?: ReactNode;
}) {
  const filter = useFactoryUi((state) => state.filter);
  const setFilter = useFactoryUi((state) => state.setFilter);
  const notifications = useNotificationOffer();
  return (
    <div className="view-intro" data-factory-live="" data-needs-you={count}>
      {children}
      {worksets > 0 ? (
        <input
          type="search"
          className="outcome-filter"
          data-outcome-filter=""
          placeholder="Filter outcomes"
          aria-label="Filter outcomes"
          aria-keyshortcuts="/"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            setFilter("");
            event.currentTarget.blur();
          }}
        />
      ) : null}
      <p className="factory-keys">
        {writable ? (
          <>
            <kbd>N</kbd> new
          </>
        ) : null}
        {worksets > 0 ? (
          <>
            <kbd>/</kbd> filter
          </>
        ) : null}
        <kbd>J</kbd>
        <kbd>K</kbd> move <kbd>↵</kbd> open <kbd>1</kbd>–<kbd>9</kbd> answer
      </p>
      <button
        type="button"
        data-factory-notify=""
        hidden={!notifications.offered}
        onClick={notifications.ask}
      >
        Notify me about decisions
      </button>
      {factoryMode && writable ? <OpenAgents label="Agents" /> : null}
      {onPass ? (
        <button type="button" className="factory-primary factory-pass" onClick={onPass}>
          Clear what needs you <span className="mono">{count}</span>
        </button>
      ) : null}
    </div>
  );
}

/** The board's Outcomes and the context every row and panel reads. */
function contextOf({
  payload,
  companionDigest,
  writable,
  sessions = null,
  runs = null,
  now,
}: FactoryProps): { home: FactoryHome; context: HomeContext } {
  return {
    home: factoryHome(payload.worksets, runs),
    context: {
      companionDigest,
      writable,
      sessions,
      runner: runs !== null,
      now,
      path: workflowPlan({ topology: payload.topology }).paths[0]!,
      ticketFormat: payload.ticketFormat,
    },
  };
}

/** One Outcome's panel content; the Factory shows it in the slide-over panel. */
export function OutcomeDetail(props: FactoryProps & { openId: string }) {
  const { home, context } = contextOf(props);
  const all = [...home.attention, ...home.active, ...home.later, ...home.completed];
  const item = all.find((entry) => entry.workset.id === props.openId);
  if (!item) return null;
  const kind = home.attention.find((entry) => entry.workset.id === props.openId)?.kind ?? null;
  return <OutcomePanel item={item} kind={kind} context={context} />;
}

/** Outcomes as lists of one line each; everything else opens in the Outcome's panel. */
export function Factory({
  payload,
  companionDigest,
  writable,
  sessions = null,
  runs = null,
  now,
  openId,
  factoryMode = false,
}: FactoryProps) {
  const { home, context } = contextOf({ payload, companionDigest, writable, sessions, runs, now });
  const { kinds, ordered, attention, running, later, completed, shownCount, query } =
    useBoard(home);
  const idle = running.all.length === 0 && home.attention.length === 0;
  useFactoryKeys();
  useNeedsYou(home.attention.length);
  const [list, setList] = useState<ListFilter>("all");
  const [pass, setPass] = useState(false);
  const address = useOutcomeAddress();
  const shows = (section: ListFilter) => list === "all" || list === section;
  // A pass walks only what needs the person; otherwise the panel walks the board in order.
  const walk = pass ? home.attention : ordered;
  const open = openId ? (ordered.find((item) => item.workset.id === openId) ?? null) : null;
  const agentsOpen = useFactoryUi((state) => state.agentsOpen);
  const setAgentsOpen = useFactoryUi((state) => state.setAgentsOpen);
  return (
    <FactoryCompanion.Provider value={companionDigest}>
      <section
        className={cn(PAGE_PAD, "view-section factory-home grid content-start gap-4 pb-10")}
        aria-label="Factory"
      >
        <OutcomeInput repositories={payload.linkedRepositories} context={context} />
        <BoardToolbar
          count={home.attention.length}
          worksets={payload.worksets.length}
          writable={writable}
          factoryMode={factoryMode}
          onPass={
            home.attention.length > 0
              ? () => {
                  setPass(true);
                  useFactoryUi.getState().setStepped(false);
                  address.open(home.attention[0]!.workset.id);
                }
              : undefined
          }
        >
          {payload.worksets.length > 0 ? (
            <Pills
              label="Show outcomes"
              value={list}
              onChange={setList}
              options={[
                { value: "all", label: "All", count: payload.worksets.length },
                {
                  value: "attention",
                  label: "Needs you",
                  count: home.attention.length,
                  tone: "warn",
                },
                { value: "active", label: "Running", count: running.all.length },
                { value: "later", label: "Later", count: home.later.length },
                { value: "completed", label: "Done", count: home.completed.length },
              ]}
            />
          ) : null}
        </BoardToolbar>
        {shows("attention") && attention.length > 0 ? (
          <OutcomeList label="Needs you" section="attention" count={attention.length}>
            {attention.map((item) => (
              <OutcomeRow
                key={item.workset.id}
                item={item}
                context={context}
                lead={
                  <span className="attention-kind" data-kind={item.kind}>
                    {attentionLabel(item.kind, item.run)}
                  </span>
                }
              />
            ))}
          </OutcomeList>
        ) : null}
        {shows("active") && running.shown.length > 0 ? (
          <OutcomeList label="Running" section="active" count={running.shown.length}>
            {running.shown.map((item) => (
              <OutcomeRow key={item.workset.id} item={item} context={context} />
            ))}
          </OutcomeList>
        ) : null}
        {payload.worksets.length === 0 ? (
          <FirstRun />
        ) : idle ? (
          <p className="note">The factory is idle. Describe an outcome to get it started.</p>
        ) : null}
        <p
          className="note outcome-filter-empty"
          data-outcome-filter-empty=""
          hidden={!query || shownCount > 0}
        >
          No outcomes match the filter.
        </p>
        {shows("later") && later.length > 0 ? (
          <OutcomeList label="Later" section="later" count={later.length}>
            {later.map((item) => (
              <OutcomeRow
                key={item.workset.id}
                item={item}
                context={context}
                progress={false}
                trailing={actionFor(item, context)("start", "Start")}
              />
            ))}
          </OutcomeList>
        ) : null}
        {shows("completed") ? (
          <Completed items={completed} context={context} expanded={Boolean(query)} />
        ) : null}
        <SidePanel
          items={walk.map((item) => item.workset.id)}
          current={open?.workset.id ?? null}
          onSelect={(id) => {
            if (id === null) {
              setPass(false);
              address.close();
              return;
            }
            useFactoryUi.getState().setStepped(true);
            address.step(id);
          }}
          pass={pass ? "Needs you" : undefined}
          wide
          title={open ? open.workset.title : "Outcome"}
        >
          {open ? (
            <OutcomePanel
              key={open.workset.id}
              item={open}
              kind={kinds.get(open.workset.id) ?? null}
              context={context}
            />
          ) : null}
        </SidePanel>
        {payload.worksetProblems.length > 0 ? (
          <Warnings
            warnings={payload.worksetProblems.map((problem) => `${problem.path} ${problem.reason}`)}
          />
        ) : null}
        <Warnings warnings={payload.warnings} />
        {factoryMode && writable && agentsOpen ? (
          <AgentsDialog onClose={() => setAgentsOpen(false)} />
        ) : null}
      </section>
    </FactoryCompanion.Provider>
  );
}
