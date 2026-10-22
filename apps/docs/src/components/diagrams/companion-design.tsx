import { DiagramFrame, Flow } from "./frame";

const stages = [
  { title: "Set policy", code: "mate companion setup", detail: "Agents, capabilities, Git mode" },
  { title: "Write rules", code: "AGENTS.md", detail: "Team conventions" },
  { title: "Add skills", code: ".claude/skills/", detail: "Team workflows" },
  { title: "Guard secrets", code: "framework.yaml", detail: "Extra deny and allow patterns" },
  { title: "Roll out", code: "git push", detail: "Teammates link and launch" },
];

/** How a companion is designed in its own repository, then shared with the team. */
export function CompanionDesign() {
  return (
    <DiagramFrame caption="Everything is designed in the companion and reaches every linked repository on the next launch">
      <Flow items={stages} wideFrom="lg">
        {(stage) => (
          <>
            <div className="text-sm font-semibold">{stage.title}</div>
            <code className="mt-1.5 block truncate font-mono text-[11px] text-fd-primary">
              {stage.code}
            </code>
            <div className="mt-1.5 text-[11px] text-fd-muted-foreground">{stage.detail}</div>
          </>
        )}
      </Flow>
    </DiagramFrame>
  );
}
