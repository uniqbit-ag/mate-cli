/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Text } from "ink";

import { BRAND_ACCENT } from "../../brand/palette";

export interface SelectMenuItem {
  key: string;
  label: string;
  description?: string;
  indicator?: string;
  dimColor?: boolean;
}

interface SelectMenuProps {
  items: SelectMenuItem[];
  activeIndex: number;
  mode?: "multi" | "radio";
}

export function SelectMenu({ items, activeIndex, mode = "multi" }: SelectMenuProps) {
  return (
    <>
      {items.map((item, i) => {
        const active = i === activeIndex;
        const indicator = item.indicator ?? (mode === "radio" ? "○" : undefined);
        return (
          <Text key={item.key} dimColor={item.dimColor} wrap="truncate-end">
            <Text color={active ? BRAND_ACCENT : undefined}>
              {active ? "▸" : " "}
              {indicator !== undefined ? ` ${indicator}` : ""}
            </Text>{" "}
            <Text bold={active}>{item.label}</Text>
            {item.description ? <Text dimColor> {item.description}</Text> : null}
          </Text>
        );
      })}
    </>
  );
}
