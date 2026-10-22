import { DiagramFrame, Flow } from "./frame";
import { LaunchPipelineSteps } from "./launch-pipeline";

const steps = [
  {
    title: "Install",
    commands: ["npm install -g @uniqbit/mate", "mate install"],
    detail: "Once per machine, then in the working repository.",
  },
  {
    title: "Link",
    commands: ["mate companion link"],
    detail: "Pick or clone a companion and install what it selects.",
  },
  {
    title: "Launch",
    commands: ["mate claude", "mate opencode"],
    detail: "Start an agent with the companion context wired in.",
  },
];

/** The quickstart flow, and what the launch step does. */
export function InstallLinkLaunch() {
  return (
    <DiagramFrame caption="Install once, link a companion, then launch from the working repository">
      <Flow items={steps}>
        {(step) => (
          <>
            <div className="text-sm font-semibold">{step.title}</div>
            <div className="mt-2 space-y-1">
              {step.commands.map((command) => (
                <code
                  key={command}
                  className="block truncate rounded bg-fd-muted px-2 py-1 font-mono text-xs"
                >
                  {command}
                </code>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-fd-muted-foreground">{step.detail}</p>
          </>
        )}
      </Flow>
      <div className="mt-5 border-t pt-4">
        <p className="mb-3 text-xs font-medium tracking-wide text-fd-muted-foreground uppercase">
          Every launch runs
        </p>
        <LaunchPipelineSteps />
      </div>
    </DiagramFrame>
  );
}
