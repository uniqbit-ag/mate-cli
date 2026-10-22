import { DiagramFrame, Flow } from "./frame";

const stages = [
  { title: "Resolve", detail: "Find the companion linked to this working repository." },
  { title: "Sync", detail: "Copy companion instructions, skills, and capabilities into place." },
  { title: "Index", detail: "Refresh enabled code indexes such as TokenSave and Graphify." },
  { title: "Launch", detail: "Start Claude Code or OpenCode in the working repository." },
];

export function LaunchPipelineSteps() {
  return (
    <Flow items={stages}>
      {(stage, index) => (
        <>
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-fd-primary text-[11px] font-semibold text-fd-primary-foreground">
              {index + 1}
            </span>
            <span className="text-sm font-semibold">{stage.title}</span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-fd-muted-foreground">{stage.detail}</p>
        </>
      )}
    </Flow>
  );
}

/** What `mate claude` and `mate opencode` do before the agent starts. */
export function LaunchPipeline() {
  return (
    <DiagramFrame caption="What happens when you run mate claude or mate opencode">
      <LaunchPipelineSteps />
    </DiagramFrame>
  );
}
