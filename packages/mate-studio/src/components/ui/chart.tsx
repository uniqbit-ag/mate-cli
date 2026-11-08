import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ResponsiveContainer, Tooltip } from "recharts";

import { cn } from "../../lib/cn";

export type ChartConfig = Record<string, { label: ReactNode; color: string }>;
const ChartContext = createContext<ChartConfig>({});

/** Base-registry shadcn chart composition, using Studio tokens rather than a second theme. */
export function ChartContainer({
  config,
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  config: ChartConfig;
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  const id = useId();
  const style = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) =>
      /^[a-zA-Z0-9_-]+$/.test(key) ? [[`--color-${key}`, value.color]] : [],
    ),
  ) as CSSProperties;
  return (
    <ChartContext.Provider value={config}>
      <div
        data-slot="chart"
        data-chart={id}
        style={style}
        className={cn(
          "h-[210px] w-full min-w-0 text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted [&_.recharts-surface:focus-visible]:outline-accent",
          className,
        )}
        {...props}
      >
        <ResponsiveContainer initialDimension={{ width: 640, height: 210 }}>
          {children}
        </ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Tooltip;

export function ChartTooltipContent({
  active,
  payload,
  label,
  formatter = String,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown }[];
  label?: unknown;
  formatter?: (value: number) => string;
}) {
  const config = useContext(ChartContext);
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-control border border-rule bg-surface px-3 py-2 text-xs text-text shadow-float">
      <div className="mb-1 text-muted">{String(label)} · UTC</div>
      {payload.map((entry) => (
        <div key={String(entry.dataKey)} className="flex items-center gap-4">
          <span>{config[String(entry.dataKey)]?.label ?? "Usage"}</span>
          <span className="ml-auto font-mono">
            {typeof entry.value === "number" ? formatter(entry.value) : "Unknown"}
          </span>
        </div>
      ))}
    </div>
  );
}
