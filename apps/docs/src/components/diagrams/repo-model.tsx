import { Arrow, DiagramFrame } from "./frame";

const companionHolds = [
  "Mate configuration (.mate/config/)",
  "Agent instructions and skills",
  "Capability-managed files",
  "OpenSpec changes and specs",
  "Reports and other agent output",
];

const workingRepos = ["web-app", "api-service", "shared-lib"];

/** One companion repository linked to several working repositories. */
export function RepoModel() {
  return (
    <DiagramFrame caption="One companion serves many working repositories. Its managed files are synced in at every launch.">
      <div className="flex flex-col items-stretch gap-3 @2xl:flex-row @2xl:items-center">
        <div className="flex-1 rounded-lg border-2 border-fd-primary/60 bg-fd-background p-4">
          <div className="text-xs font-medium tracking-wide text-fd-primary uppercase">
            Companion repository
          </div>
          <div className="mt-0.5 text-sm font-semibold">Context for agents</div>
          <ul className="mt-3 space-y-1.5 text-xs text-fd-muted-foreground">
            {companionHolds.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fd-primary" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <Arrow label="sync at launch" />
        <div className="flex flex-1 flex-col gap-2">
          {workingRepos.map((name) => (
            <div key={name} className="rounded-lg border bg-fd-background p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium tracking-wide text-fd-muted-foreground uppercase">
                  Working repository
                </span>
                <code className="font-mono text-xs">{name}</code>
              </div>
              <p className="mt-1 text-xs text-fd-muted-foreground">
                Product code and tests, plus a local, git-excluded <code>.mate/</code> link.
              </p>
            </div>
          ))}
        </div>
      </div>
    </DiagramFrame>
  );
}
