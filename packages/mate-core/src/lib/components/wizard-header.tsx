/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Box, Text } from "ink";

import { BRAND_ACCENT } from "../../brand/palette";

interface WizardHeaderProps {
  title: string;
  step: number;
  totalSteps: number;
}

export function WizardHeader({ title, step, totalSteps }: WizardHeaderProps) {
  const showStepCounter = totalSteps > 1;

  return (
    <Box width="100%" justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color={BRAND_ACCENT}>
          mate
        </Text>
        <Text dimColor> · {title}</Text>
      </Text>
      {showStepCounter ? (
        <Box flexShrink={0} marginLeft={2}>
          <Text dimColor>
            {step + 1} / {totalSteps}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
